import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConnectionString, redactConnectionString } from './connection.ts';
import {
  applyAppMigrations,
  type ConfigSnapshot,
  ensureSchemas,
  FRAMEWORK_BRANCH_DIFFERENCE,
  hashConfig,
  syncConfig,
} from './migrate.ts';
import { SAMPLE_WAVE_NAME, seedDev, TEST_ACTORS } from './seed.ts';
import { createTestDatabase, type TestDatabase } from './test-support.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t010_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

const sql = async (text: string, values: unknown[] = []) =>
  (await t.db.pool.query(text, values)).rows as Record<string, unknown>[];

describe('[DATA-030] steps 1 and 2', () => {
  it('[DATA-030] step 1 creates schemas app, auth and bullmq and the pg_trgm extension, idempotently', async () => {
    await ensureSchemas(t.db.pool);
    await ensureSchemas(t.db.pool);
    const schemas = await sql(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('app','auth','bullmq') ORDER BY 1`,
    );
    expect(schemas.map((r) => r.schema_name)).toEqual(['app', 'auth', 'bullmq']);
    const ext = await sql(`SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(ext).toHaveLength(1);
  });

  it('[DATA-030] step 2 put every table in schema app and none in public, auth or bullmq', async () => {
    const tables = await sql(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_schema IN ('app','auth','bullmq','public') AND table_type = 'BASE TABLE'`,
    );
    const bySchema = new Set(
      tables.filter((r) => r.table_name !== '_prisma_migrations').map((r) => r.table_schema),
    );
    expect(bySchema).toEqual(new Set(['app']));
    const names = tables.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining(['actor', 'migration', 'facet_snapshot', 'quota_event']),
    );
  });

  it('[DATA-002] has no foreign key across schemas', async () => {
    const cross = await sql(
      `SELECT c.conname FROM pg_constraint c
         JOIN pg_class a ON a.oid = c.conrelid JOIN pg_namespace an ON an.oid = a.relnamespace
         JOIN pg_class b ON b.oid = c.confrelid JOIN pg_namespace bn ON bn.oid = b.relnamespace
        WHERE c.contype = 'f' AND an.nspname <> bn.nspname`,
    );
    expect(cross).toEqual([]);
  });

  it('[DATA-031] migrations are forward-only: no drop or rename statements', () => {
    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) =>
      d.isDirectory(),
    );
    expect(dirs.length).toBeGreaterThanOrEqual(2);
    for (const dir of dirs) {
      const text = readFileSync(join(MIGRATIONS_DIR, dir.name, 'migration.sql'), 'utf8')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      expect(text, dir.name).not.toMatch(
        /\b(DROP\s+(TABLE|COLUMN|INDEX|TYPE|SCHEMA)|RENAME\s+(TO|COLUMN))\b/i,
      );
    }
  });
});

describe('[DATA-011] required indexes', () => {
  const indexDefs = async () =>
    (await sql(
      `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'app'`,
    )) as {
      tablename: string;
      indexname: string;
      indexdef: string;
    }[];
  const find = async (table: string, pattern: RegExp) =>
    (await indexDefs()).find((i) => i.tablename === table && pattern.test(i.indexdef));

  it('[DATA-011] has a unique partial index on run (migration_id) WHERE status IN (queued, running)', async () => {
    const i = await find('run', /UNIQUE.*\(migration_id\) WHERE/s);
    expect(i?.indexdef).toMatch(/status = ANY \(ARRAY\['queued'.*'running'/);
  });

  it('[DATA-011] has a unique partial index on migration (route_id) WHERE scope = endpoint', async () => {
    const i = await find('migration', /UNIQUE.*\(route_id\) WHERE.*endpoint/s);
    expect(i).toBeDefined();
  });

  it('[DATA-011] has the migration, repository, snapshot, quota and audit indexes', async () => {
    expect(await find('migration', /\(route_id, status, readiness\)/)).toBeDefined();
    expect(await find('migration', /\(wave_id\)/)).toBeDefined();
    expect(await find('migration', /USING gin \(blocker_codes\)/)).toBeDefined();
    expect(await find('repository', /\(endpoint_id, namespace_id\)/)).toBeDefined();
    expect(await find('repository', /USING gin \(full_path gin_trgm_ops\)/)).toBeDefined();
    expect(
      await find('facet_snapshot', /\(repository_id, facet_key, side, fetched_at DESC\)/),
    ).toBeDefined();
    expect(await find('quota_event', /\(bucket_key, at\)/)).toBeDefined();
    expect(await find('audit_event', /\(at DESC\)/)).toBeDefined();
    expect(await find('audit_event', /\(subject_type, subject_id\)/)).toBeDefined();
    const ed = await find('expected_difference', /\(route_id, migration_id, facet_key\) WHERE/);
    expect(ed?.indexdef).toMatch(/revoked_at IS NULL/);
  });

  it('[DATA-011] the trigram index serves a similarity search on repository.full_path', async () => {
    const ns = await t.db.privileged.endpoint.create({
      data: {
        id: 'idx-ep',
        providerType: 'p',
        displayName: 'e',
        baseUrl: 'http://x',
        status: 'active',
        configHash: 'h',
      },
    });
    const namespace = await t.db.privileged.namespace.create({
      data: { endpointId: ns.id, providerId: 'n', kind: 'k', slug: 's', name: 'n' },
    });
    await t.db.privileged.repository.create({
      data: {
        endpointId: ns.id,
        namespaceId: namespace.id,
        providerId: 'r1',
        slug: 'platform-api',
        name: 'platform-api',
        fullPath: 'acme/PLAT/platform-api',
        isPrivate: true,
        lastInventoriedAt: new Date(),
      },
    });
    const hits = await t.db.privileged.repository.findMany({
      where: { fullPath: { contains: 'form-ap', mode: 'insensitive' } },
    });
    expect(hits).toHaveLength(1);
  });

  it('[DOM-010] the database refuses a second queued or running Run for one Migration', async () => {
    const p = t.db.privileged;
    await p.route.create({
      data: {
        id: 'run-route',
        sourceEndpointId: 'idx-ep',
        targetEndpointId: 'idx-ep',
        targetNamespacePath: 'x',
        policies: {},
        defaults: {},
        configHash: 'h',
        sourcePostAction: 'none',
      },
    });
    const m = await p.migration.create({ data: { scope: 'endpoint', routeId: 'run-route' } });
    const actor = await p.actor.create({
      data: { kind: 'service', displayName: 's', role: 'operator' },
    });
    const run = (status: 'queued' | 'running' | 'succeeded' | 'failed') =>
      p.run.create({
        data: { migrationId: m.id, kind: 'verify', status, triggeredById: actor.id, options: {} },
      });
    await run('succeeded');
    await run('failed');
    await run('queued');
    await expect(run('queued')).rejects.toMatchObject({ dbErrorCode: '23505' });
    await expect(run('running')).rejects.toMatchObject({ dbErrorCode: '23505' });
    await p.run.updateMany({
      where: { migrationId: m.id, status: 'queued' },
      data: { status: 'cancelled' },
    });
    await expect(run('running')).resolves.toBeDefined();
  });

  it('[DOM-014] the database refuses a second endpoint-scope Migration for one Route', async () => {
    const p = t.db.privileged;
    await expect(
      p.migration.create({ data: { scope: 'endpoint', routeId: 'run-route' } }),
    ).rejects.toMatchObject({
      dbErrorCode: '23505',
    });
    // Repository-scope Migrations are not limited by that index.
    const repo = await p.repository.findFirstOrThrow();
    await expect(
      p.migration.create({
        data: { scope: 'repository', routeId: 'run-route', sourceRepositoryId: repo.id },
      }),
    ).resolves.toBeDefined();
  });
});

describe('[DATA-030] step 5: config sync', () => {
  // A database of its own: sync retires every Endpoint and Route that the snapshot omits.
  let s: TestDatabase;
  beforeAll(async () => {
    s = await createTestDatabase('gm_t010_');
  }, 120_000);
  afterAll(async () => {
    await s?.drop();
  });

  const endpoint = (id: string, extra = '') => ({
    id,
    providerType: 'type-a',
    displayName: id,
    baseUrl: `http://${id}.test`,
    configHash: hashConfig({ id, extra }),
  });
  const route = (id: string, over: Record<string, unknown> = {}) => {
    const spec = {
      id,
      sourceEndpointId: 'sync-src',
      targetEndpointId: 'sync-dst',
      targetNamespacePath: 'acme',
      policies: { acceptLossy: [] },
      defaults: {},
      sourcePostAction: 'read-only',
      ...over,
    };
    return { ...spec, configHash: hashConfig(spec) };
  };
  const snapshot = (over: Partial<ConfigSnapshot> = {}): ConfigSnapshot => ({
    endpoints: [endpoint('sync-src'), endpoint('sync-dst')],
    routes: [route('sync-route')],
    ...over,
  });

  it('[DATA-030] creates Endpoints and Routes, the endpoint-scope Migration and the system Expected Difference', async () => {
    const result = await syncConfig(s.db.privileged, snapshot());
    expect(result.endpoints).toEqual({ created: 2, updated: 0, retired: 0, unchanged: 0 });
    expect(result.routes).toEqual({ created: 1, updated: 0, retired: 0, unchanged: 0 });
    const p = s.db.privileged;
    expect((await p.endpoint.findUnique({ where: { id: 'sync-src' } }))?.status).toBe('active');
    const migrations = await p.migration.findMany({ where: { routeId: 'sync-route' } });
    expect(migrations.map((m) => m.scope)).toEqual(['endpoint']);
    expect(migrations[0]?.status).toBe('discovered');
    const diffs = await p.expectedDifference.findMany({ where: { routeId: 'sync-route' } });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({
      ...FRAMEWORK_BRANCH_DIFFERENCE,
      migrationId: null,
      createdById: null,
      revokedAt: null,
    });
  });

  it('[DATA-030] is idempotent: a second run changes nothing', async () => {
    const p = s.db.privileged;
    const before = {
      migrations: await p.migration.count({ where: { routeId: 'sync-route' } }),
      diffs: await p.expectedDifference.count({ where: { routeId: 'sync-route' } }),
    };
    const result = await syncConfig(p, snapshot());
    expect(result.endpoints).toEqual({ created: 0, updated: 0, retired: 0, unchanged: 2 });
    expect(result.routes).toEqual({ created: 0, updated: 0, retired: 0, unchanged: 1 });
    expect(result.staleMigrations).toBe(0);
    expect(await p.migration.count({ where: { routeId: 'sync-route' } })).toBe(before.migrations);
    expect(await p.expectedDifference.count({ where: { routeId: 'sync-route' } })).toBe(
      before.diffs,
    );
  });

  it('[LIF-021] a changed Route configHash marks its analysed Migrations stale and resets a moved target namespace', async () => {
    const p = s.db.privileged;
    const m = await p.migration.findFirstOrThrow({ where: { routeId: 'sync-route' } });
    const analysis = await p.analysis.create({
      data: {
        migrationId: m.id,
        sourceSnapshotIds: [],
        targetSnapshotIds: [],
        readiness: 'ready',
        translation: {},
      },
    });
    const future = new Date(Date.now() + 7 * 86_400_000);
    await p.migration.update({
      where: { id: m.id },
      data: { latestAnalysisId: analysis.id, analysisStaleAt: future },
    });
    const ns = await p.namespace.create({
      data: { endpointId: 'sync-dst', providerId: 'org', kind: 'org', slug: 'acme', name: 'acme' },
    });
    await p.route.update({ where: { id: 'sync-route' }, data: { targetNamespaceId: ns.id } });

    const result = await syncConfig(
      p,
      snapshot({ routes: [route('sync-route', { targetNamespacePath: 'other' })] }),
    );
    expect(result.routes.updated).toBe(1);
    expect(result.staleMigrations).toBe(1);
    const after = await p.migration.findUniqueOrThrow({ where: { id: m.id } });
    expect((after.analysisStaleAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(
      (await p.route.findUniqueOrThrow({ where: { id: 'sync-route' } })).targetNamespaceId,
    ).toBeNull();
  });

  it('[DATA-030] marks Endpoints and Routes missing from config retired, and revives them when they return', async () => {
    const p = s.db.privileged;
    const gone = await syncConfig(p, { endpoints: [endpoint('sync-src')], routes: [] });
    expect(gone.endpoints.retired).toBe(1);
    expect(gone.routes.retired).toBe(1);
    expect((await p.endpoint.findUniqueOrThrow({ where: { id: 'sync-dst' } })).status).toBe(
      'retired',
    );
    expect(
      (await p.route.findUniqueOrThrow({ where: { id: 'sync-route' } })).retiredAt,
    ).not.toBeNull();
    const again = await syncConfig(p, { endpoints: [endpoint('sync-src')], routes: [] });
    expect(again.endpoints.retired + again.routes.retired).toBe(0);

    await syncConfig(
      p,
      snapshot({ routes: [route('sync-route', { targetNamespacePath: 'other' })] }),
    );
    expect((await p.endpoint.findUniqueOrThrow({ where: { id: 'sync-dst' } })).status).toBe(
      'active',
    );
    expect((await p.route.findUniqueOrThrow({ where: { id: 'sync-route' } })).retiredAt).toBeNull();
    expect(await p.migration.count({ where: { routeId: 'sync-route', scope: 'endpoint' } })).toBe(
      1,
    );
    expect(
      await p.expectedDifference.count({ where: { routeId: 'sync-route', revokedAt: null } }),
    ).toBe(1);
  });

  it('[DATA-030] rolls the whole sync back when one step fails', async () => {
    const p = s.db.privileged;
    await expect(
      syncConfig(p, {
        endpoints: [endpoint('sync-src'), endpoint('sync-new')],
        routes: [route('sync-bad', { targetEndpointId: 'no-such-endpoint' })],
      }),
    ).rejects.toBeDefined();
    expect(await p.endpoint.findUnique({ where: { id: 'sync-new' } })).toBeNull();
  });
});

describe('[DATA-040] seed', () => {
  it('[DATA-040] creates one test Actor per role, a sample Wave and a webhook allowlist sample, idempotently', async () => {
    const p = t.db.privileged;
    await syncConfig(p, {
      endpoints: [
        { id: 'sd-a', providerType: 'p', displayName: 'a', baseUrl: 'http://a', configHash: 'h' },
        { id: 'sd-b', providerType: 'p', displayName: 'b', baseUrl: 'http://b', configHash: 'h' },
      ],
      routes: [
        {
          id: 'sd-route',
          sourceEndpointId: 'sd-a',
          targetEndpointId: 'sd-b',
          targetNamespacePath: 'x',
          policies: {},
          defaults: {},
          sourcePostAction: 'none',
          configHash: 'h',
        },
      ],
    });
    const first = await seedDev(p, { routeId: 'sd-route' });
    expect(first).toEqual({ actors: 3, wave: true, allowlistEntry: true });
    const second = await seedDev(p, { routeId: 'sd-route' });
    expect(second).toEqual({ actors: 0, wave: false, allowlistEntry: false });
    const actors = await p.actor.findMany({
      where: { email: { in: TEST_ACTORS.map((a) => a.email) } },
    });
    expect(actors.map((a) => a.role).sort()).toEqual(['admin', 'operator', 'viewer']);
    expect(await p.wave.count({ where: { name: SAMPLE_WAVE_NAME } })).toBe(1);
    expect(await p.webhookAllowlistEntry.count({ where: { routeId: 'sd-route' } })).toBe(1);
  });

  it('[DATA-040] seeds only the Actors when no Route exists yet', async () => {
    const empty = await createTestDatabase('gm_t010_');
    try {
      expect(await seedDev(empty.db.privileged)).toEqual({
        actors: 3,
        wave: false,
        allowlistEntry: false,
      });
    } finally {
      await empty.drop();
    }
  }, 120_000);
});

describe('[DATA-010] connection string', () => {
  const parts = {
    host: 'db.internal',
    port: 5432,
    database: 'git_migrator',
    user: 'git_migrator',
    sslmode: 'require',
  };

  it('[DATA-010] assembles host, port, database, user, sslmode and the secret', () => {
    expect(buildConnectionString({ ...parts, password: 's3cret' })).toBe(
      'postgresql://git_migrator:s3cret@db.internal:5432/git_migrator?sslmode=require',
    );
  });

  it('[DATA-010] percent-encodes the password so it cannot change the host or database', () => {
    const url = new URL(buildConnectionString({ ...parts, password: 'p@ss/w:rd#?' }));
    expect(url.hostname).toBe('db.internal');
    expect(url.pathname).toBe('/git_migrator');
    expect(decodeURIComponent(url.password)).toBe('p@ss/w:rd#?');
  });

  it('[DATA-010] omits the password separator when there is no password and brackets IPv6 hosts', () => {
    expect(buildConnectionString({ ...parts, host: '::1', sslmode: 'disable', password: '' })).toBe(
      'postgresql://git_migrator@[::1]:5432/git_migrator?sslmode=disable',
    );
  });

  it('[DATA-010] redacts the password for logs', () => {
    const redacted = redactConnectionString(
      buildConnectionString({ ...parts, password: 'topsecret' }),
    );
    expect(redacted).not.toContain('topsecret');
    expect(redacted).toContain('git_migrator:***@db.internal');
  });
});

describe('[DATA-003] one login role owns the schemas', () => {
  it('[DATA-003] the application role owns app, auth and bullmq and may create schemas', async () => {
    const owners = await sql(
      `SELECT n.nspname, pg_get_userbyid(n.nspowner) = current_user AS mine
         FROM pg_namespace n WHERE n.nspname IN ('app','auth','bullmq') ORDER BY 1`,
    );
    expect(owners).toEqual([
      { nspname: 'app', mine: true },
      { nspname: 'auth', mine: true },
      { nspname: 'bullmq', mine: true },
    ]);
    const [can] = await sql(
      `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS ok`,
    );
    expect(can?.ok).toBe(true);
  });
});

describe('[DOM-014] Migration.scope and sourceRepositoryId agree', () => {
  it('[DOM-014] the database refuses an endpoint-scope Migration with a source Repository and a repository-scope one without', async () => {
    const p = t.db.privileged;
    const repo = await p.repository.findFirstOrThrow();
    await p.route.create({
      data: {
        id: 'check-route',
        sourceEndpointId: 'idx-ep',
        targetEndpointId: 'idx-ep',
        targetNamespacePath: 'x',
        policies: {},
        defaults: {},
        configHash: 'h',
        sourcePostAction: 'none',
      },
    });
    await expect(
      p.migration.create({
        data: { scope: 'endpoint', routeId: 'check-route', sourceRepositoryId: repo.id },
      }),
    ).rejects.toMatchObject({ dbErrorCode: '23514' });
    await expect(
      p.migration.create({ data: { scope: 'repository', routeId: 'check-route' } }),
    ).rejects.toMatchObject({ dbErrorCode: '23514' });
  });
});

describe('[DOM-011] updated_at is maintained by the database', () => {
  it('[DOM-011] a privileged update moves Migration.updatedAt and ManualTask.updatedAt', async () => {
    const p = t.db.privileged;
    // Created by the DOM-014 test above.
    const m = await p.migration.findFirstOrThrow({ where: { scope: 'repository' } });
    const before = m.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 15));
    const after = await p.migration.update({
      where: { id: m.id },
      data: { plannedTargetName: 'b' },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before);

    const task = await p.manualTask.create({
      data: {
        migrationId: m.id,
        facetKey: 'secrets',
        code: 'secrets.set-value',
        phase: 'post',
        origin: 'analysis',
        params: {},
        verifiable: false,
        paramsHash: 'trigger',
      },
    });
    await new Promise((r) => setTimeout(r, 15));
    const touched = await p.manualTask.update({ where: { id: task.id }, data: { note: 'n' } });
    expect(touched.updatedAt.getTime()).toBeGreaterThan(task.updatedAt.getTime());
    expect(touched.createdAt.getTime()).toBe(task.createdAt.getTime());
  });
});

describe('[DATA-031] the deployed migrations match the schema', () => {
  it('[DATA-031] zen migrate dev finds nothing to add (raw-SQL objects do not count as drift)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'gm-drift-'));
    try {
      cpSync(join(MIGRATIONS_DIR, '..', 'schema.zmodel'), join(work, 'schema.zmodel'));
      cpSync(MIGRATIONS_DIR, join(work, 'migrations'), { recursive: true });
      symlinkSync(join(MIGRATIONS_DIR, '..', 'node_modules'), join(work, 'node_modules'), 'dir');
      const require = createRequire(import.meta.url);
      const cli = join(dirname(require.resolve('@zenstackhq/cli/package.json')), 'bin', 'cli');
      const run = spawnSync(
        process.execPath,
        [
          cli,
          'migrate',
          'dev',
          '--schema',
          join(work, 'schema.zmodel'),
          '--name',
          'drift',
          '--create-only',
          '--no-version-check',
        ],
        { cwd: work, encoding: 'utf8', env: { ...process.env, DATABASE_URL: t.connectionString } },
      );
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
      const created = readdirSync(join(work, 'migrations')).filter((d) => d.endsWith('_drift'));
      expect(created).toHaveLength(1);
      const sqlText = readFileSync(
        join(work, 'migrations', created[0] as string, 'migration.sql'),
        'utf8',
      );
      expect(sqlText.trim()).toBe('-- This is an empty migration.');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('[DEP-003] the migrate step writes nothing into the package', () => {
  it('[DEP-003] a failed deploy leaves packages/db unchanged and removes its temporary directory', async () => {
    const listing = () =>
      readdirSync(join(MIGRATIONS_DIR, '..'), { recursive: true })
        .map(String)
        .filter((f) => !f.startsWith('node_modules'))
        .sort();
    const before = listing();
    const workRoot = mkdtempSync(join(tmpdir(), 'gm-root-'));
    const bad = t.connectionString.replace(/:[^:@/]*@/, ':wrong-password@');
    await expect(
      applyAppMigrations({ connectionString: bad, output: 'pipe', workRoot }),
    ).rejects.toThrow(/exited with status/);
    expect(listing()).toEqual(before);
    expect(readdirSync(workRoot)).toEqual([]);
    rmSync(workRoot, { recursive: true, force: true });
  }, 60_000);

  it('[DEP-003] signal handlers are removed after a failed mkdtemp and after a failed run', async () => {
    const counts = () => [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const before = counts();
    await expect(
      applyAppMigrations({
        connectionString: t.connectionString,
        output: 'pipe',
        workRoot: join(tmpdir(), 'gm-missing-root', 'nope'),
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(counts()).toEqual(before);
    await applyAppMigrations({ connectionString: t.connectionString, output: 'pipe' });
    expect(counts()).toEqual(before);
    const workRoot = mkdtempSync(join(tmpdir(), 'gm-root-'));
    const bad = t.connectionString.replace(/:[^:@/]*@/, ':wrong-password@');
    await expect(
      applyAppMigrations({ connectionString: bad, output: 'pipe', workRoot }),
    ).rejects.toThrow(/exited with status/);
    expect(counts()).toEqual(before);
    rmSync(workRoot, { recursive: true, force: true });
  }, 60_000);
});
