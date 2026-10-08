import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashCanonical } from '@git-migrator/core';
import type pg from 'pg';
import type { Db } from './client.ts';

/** The Postgres schemas of DATA-001. Each is owned by a different migration tool. */
export const SCHEMAS = ['app', 'auth', 'bullmq'] as const;

/**
 * DATA-030 step 1: create the three schemas and the `pg_trgm` extension. Idempotent. The extension
 * needs `azure.extensions` to allow it on Azure Flexible Server (docs/deployment.md).
 */
export async function ensureSchemas(pool: pg.Pool): Promise<void> {
  for (const schema of SCHEMAS) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  }
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
}

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface ApplyMigrationsOptions {
  readonly connectionString: string;
  /** Defaults to this package's schema.zmodel. */
  readonly schemaFile?: string;
  /** `inherit` (default) prints the ZenStack CLI output; `pipe` captures it into the error. */
  readonly output?: 'inherit' | 'pipe';
  /** Directory for the temporary working copy. Defaults to `os.tmpdir()`. */
  readonly workRoot?: string;
}

/**
 * DATA-030 step 2: `zen migrate deploy` against schema `app`. The connection string travels in the
 * child's environment (`DATABASE_URL`), never in argv. Rejects when the CLI exits non-zero.
 *
 * The ZenStack CLI writes a temporary Prisma schema next to the schema file, and the package
 * directory is read-only in the container (DEP-003). So the schema and migrations are copied to a
 * directory under `os.tmpdir()`, the CLI runs there, and the directory is removed afterwards, also
 * when the CLI fails or the process gets SIGTERM or SIGINT (the signal is forwarded to the CLI
 * and its children, and the copy is removed once they have exited). Nothing is written into the
 * package.
 */
export async function applyAppMigrations(options: ApplyMigrationsOptions): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('@zenstackhq/cli/package.json')), 'bin', 'cli');
  const sourceSchema = options.schemaFile ?? join(PACKAGE_DIR, 'schema.zmodel');
  const pipe = options.output === 'pipe';

  // Handlers go in before the working copy exists, so a signal can never kill the process between
  // creating the directory and running the CLI (which would leak the directory).
  let interrupted: NodeJS.Signals | undefined;
  let childPid: number | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    interrupted = signal;
    try {
      if (childPid !== undefined) process.kill(-childPid, signal);
    } catch {
      // The group is already gone.
    }
  };
  const onTerm = (): void => forward('SIGTERM');
  const onInt = (): void => forward('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  let work: string | undefined;
  try {
    work = mkdtempSync(join(options.workRoot ?? tmpdir(), 'gm-migrate-'));
    const dir = work;
    cpSync(sourceSchema, join(dir, 'schema.zmodel'));
    cpSync(join(dirname(sourceSchema), 'migrations'), join(dir, 'migrations'), {
      recursive: true,
    });
    // The schema names plugins by package; they resolve from the schema's directory.
    symlinkSync(join(PACKAGE_DIR, 'node_modules'), join(dir, 'node_modules'), 'dir');
    if (interrupted) throw new Error(`migration interrupted by ${interrupted}`);
    await new Promise<void>((resolve, reject) => {
      // Own process group, so a signal reaches the ZenStack CLI and the Prisma engine it starts.
      const child = spawn(
        process.execPath,
        [cli, 'migrate', 'deploy', '--schema', join(dir, 'schema.zmodel'), '--no-version-check'],
        {
          cwd: dir,
          detached: true,
          env: { ...process.env, DATABASE_URL: options.connectionString },
          stdio: pipe ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        },
      );
      childPid = child.pid;
      let captured = '';
      const capture = (chunk: Buffer): void => {
        captured += chunk.toString();
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.on('error', reject);
      child.on('close', (code) => {
        childPid = undefined;
        if (interrupted) reject(new Error(`migration interrupted by ${interrupted}`));
        else if (code === 0) resolve();
        else reject(new Error(`zen migrate deploy exited with status ${code}\n${captured}`.trim()));
      });
    });
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

export interface EndpointSpec {
  readonly id: string;
  readonly providerType: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** Hash of the whole configured Endpoint entry; see `hashConfig`. */
  readonly configHash: string;
}

export interface RouteSpec {
  readonly id: string;
  readonly sourceEndpointId: string;
  readonly targetEndpointId: string;
  readonly targetNamespacePath: string;
  readonly policies: unknown;
  readonly defaults: unknown;
  readonly sourcePostAction: string;
  /** Hash of the whole configured Route entry; a change marks its Analyses stale (LIF-021). */
  readonly configHash: string;
}

export interface ConfigSnapshot {
  readonly endpoints: readonly EndpointSpec[];
  readonly routes: readonly RouteSpec[];
}

export interface SyncCounts {
  created: number;
  updated: number;
  retired: number;
  unchanged: number;
}

export interface SyncResult {
  readonly endpoints: SyncCounts;
  readonly routes: SyncCounts;
  /** Migrations whose Analysis was marked stale because their Route's configHash changed. */
  readonly staleMigrations: number;
}

/** The hash stored as `configHash`: SHA-256 of the RFC 8785 canonical form (LIF-021). */
export function hashConfig(value: unknown): string {
  return hashCanonical(value);
}

/** System Expected Difference per Route (FAC-GIT-007). */
export const FRAMEWORK_BRANCH_DIFFERENCE = {
  facetKey: 'git-refs',
  path: '/refs[name=refs/heads/git-migrator/*]',
  reason: 'framework_mutation',
} as const;

const emptyCounts = (): SyncCounts => ({ created: 0, updated: 0, retired: 0, unchanged: 0 });

/**
 * DATA-030 step 5: upsert Endpoints and Routes from config, mark missing ones retired, create the
 * endpoint-scope Migration (DOM-014) and the system Expected Difference (FAC-GIT-007) per Route,
 * and mark Analyses stale when a Route's configHash changed. Idempotent; runs in one transaction.
 * Uses the privileged client.
 */
export async function syncConfig(db: Db, snapshot: ConfigSnapshot): Promise<SyncResult> {
  return db.$transaction(async (tx) => {
    const endpoints = emptyCounts();
    const routes = emptyCounts();
    let staleMigrations = 0;
    const now = new Date();

    const knownEndpoints = new Map((await tx.endpoint.findMany()).map((e) => [e.id, e]));
    for (const spec of snapshot.endpoints) {
      const existing = knownEndpoints.get(spec.id);
      const data = {
        providerType: spec.providerType,
        displayName: spec.displayName,
        baseUrl: spec.baseUrl,
        status: 'active' as const,
        configHash: spec.configHash,
      };
      if (!existing) {
        await tx.endpoint.create({ data: { id: spec.id, ...data } });
        endpoints.created++;
      } else if (existing.configHash !== spec.configHash || existing.status !== 'active') {
        await tx.endpoint.update({ where: { id: spec.id }, data });
        endpoints.updated++;
      } else endpoints.unchanged++;
    }
    const configuredEndpoints = new Set(snapshot.endpoints.map((e) => e.id));
    for (const e of knownEndpoints.values()) {
      if (!configuredEndpoints.has(e.id) && e.status !== 'retired') {
        await tx.endpoint.update({ where: { id: e.id }, data: { status: 'retired' } });
        endpoints.retired++;
      }
    }

    const knownRoutes = new Map((await tx.route.findMany()).map((r) => [r.id, r]));
    for (const spec of snapshot.routes) {
      const existing = knownRoutes.get(spec.id);
      const data = {
        sourceEndpointId: spec.sourceEndpointId,
        targetEndpointId: spec.targetEndpointId,
        targetNamespacePath: spec.targetNamespacePath,
        policies: spec.policies as never,
        defaults: spec.defaults as never,
        sourcePostAction: spec.sourcePostAction,
        configHash: spec.configHash,
        retiredAt: null,
      };
      if (!existing) {
        await tx.route.create({ data: { id: spec.id, ...data } });
        routes.created++;
      } else if (existing.configHash !== spec.configHash || existing.retiredAt !== null) {
        // The resolved target namespace is only valid for the same target endpoint and path.
        const moved =
          existing.targetEndpointId !== spec.targetEndpointId ||
          existing.targetNamespacePath !== spec.targetNamespacePath;
        await tx.route.update({
          where: { id: spec.id },
          data: moved ? { ...data, targetNamespaceId: null } : data,
        });
        routes.updated++;
        if (existing.configHash !== spec.configHash) {
          const stale = await tx.migration.updateMany({
            where: {
              routeId: spec.id,
              latestAnalysisId: { not: null },
              OR: [{ analysisStaleAt: null }, { analysisStaleAt: { gt: now } }],
            },
            data: { analysisStaleAt: now },
          });
          staleMigrations += stale.count;
        }
      } else routes.unchanged++;

      const endpointScope = await tx.migration.findFirst({
        where: { routeId: spec.id, scope: 'endpoint' },
        select: { id: true },
      });
      if (!endpointScope) {
        await tx.migration.create({ data: { scope: 'endpoint', routeId: spec.id } });
      }
      const system = await tx.expectedDifference.findFirst({
        where: {
          routeId: spec.id,
          migrationId: null,
          createdById: null,
          ...FRAMEWORK_BRANCH_DIFFERENCE,
          revokedAt: null,
        },
        select: { id: true },
      });
      if (!system) {
        await tx.expectedDifference.create({
          data: { routeId: spec.id, ...FRAMEWORK_BRANCH_DIFFERENCE },
        });
      }
    }
    const configuredRoutes = new Set(snapshot.routes.map((r) => r.id));
    for (const r of knownRoutes.values()) {
      if (!configuredRoutes.has(r.id) && r.retiredAt === null) {
        await tx.route.update({ where: { id: r.id }, data: { retiredAt: now } });
        routes.retired++;
      }
    }
    return { endpoints, routes, staleMigrations };
  });
}
