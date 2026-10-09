import type { E2eContext } from './context.ts';
import { asArray, asRecord, type BitbucketApi, type GithubApi } from './ports.ts';
import { repoPath } from './preconditions.ts';

/**
 * TST-032: puts the live fixture back to its starting state, so the live test can run again.
 *
 * - The target repository is deleted. It is only ever the planned target of the fixture
 *   (`{org}/{targetName}` of the context), nothing else.
 * - The source read-only changes are undone: the push restriction on `*` with no principals, and
 *   the `[MIGRATED → …] ` description prefix (LIF-070). Only state of that exact shape is touched.
 *
 * Every step is idempotent. When a running app still has the Migration, its own `rollback` and
 * `undo_source_read_only` Runs do the work first (`AppPort`); the direct provider calls then only
 * clean what is left, so a reset without an app (or after the database is gone) works the same.
 */

/** The app's own rollback and undo code paths, driven through its API. */
export interface AppPort {
  /** Does the app know a Migration for the fixture repository? Undo and rollback only then. */
  find(): Promise<{ id: string; sourceReadOnlyApplied: boolean; hasTarget: boolean } | undefined>;
  /** Starts a Run and waits for it to finish. Returns the final status. */
  run(
    migrationId: string,
    kind: 'undo_source_read_only' | 'rollback',
    confirm?: string,
  ): Promise<string>;
}

export interface ResetPorts {
  readonly bitbucket: BitbucketApi;
  readonly github: GithubApi;
  readonly app?: AppPort | undefined;
  readonly log: (line: string) => void;
}

export interface ResetReport {
  readonly appRuns: readonly string[];
  readonly targetDeleted: boolean;
  readonly restrictionsRemoved: number;
  readonly descriptionRestored: boolean;
}

/** `[MIGRATED → https://…] ` at the start of a description. */
export const MIGRATED_PREFIX = /^\[MIGRATED → [^\]]*\] /;

export async function resetLive(ctx: E2eContext, ports: ResetPorts): Promise<ResetReport> {
  const { bitbucket, github, log } = ports;
  // Say what will be touched before anything is.
  log(
    `resetting Bitbucket workspace ${ctx.bitbucket.workspace}, repository ${ctx.fixture.slug} (project ${ctx.fixture.projectKey}) and GitHub repository ${ctx.github.org}/${ctx.fixture.targetName}`,
  );
  const appRuns: string[] = [];
  if (ports.app) {
    try {
      const migration = await ports.app.find();
      if (migration?.sourceReadOnlyApplied) {
        const status = await ports.app.run(migration.id, 'undo_source_read_only');
        appRuns.push(`undo_source_read_only: ${status}`);
      }
      if (migration?.hasTarget) {
        const confirm = `${ctx.github.org}/${ctx.fixture.targetName}`;
        const status = await ports.app.run(migration.id, 'rollback', confirm);
        appRuns.push(`rollback: ${status}`);
      }
    } catch (error) {
      // The direct calls below finish the job.
      log(
        `the app could not reset the Migration (${error instanceof Error ? error.message : String(error)}); using direct provider calls`,
      );
    }
    for (const line of appRuns) log(`app Run ${line}`);
  }

  const errors: string[] = [];
  let targetDeleted = false;
  let restrictionsRemoved = 0;
  let descriptionRestored = false;
  // The two sides are independent: a failure on one never skips the other.
  try {
    targetDeleted = await resetTarget(ctx, github, log);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    ({ restrictionsRemoved, descriptionRestored } = await resetSource(ctx, bitbucket, log));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) {
    throw new Error(`The reset is incomplete:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return { appRuns, targetDeleted, restrictionsRemoved, descriptionRestored };
}

/** Deletes the target repository, after checking that it is the one the fixture creates. */
async function resetTarget(
  ctx: E2eContext,
  github: GithubApi,
  log: (line: string) => void,
): Promise<boolean> {
  const target = `${ctx.github.org}/${ctx.fixture.targetName}`;
  const params = { owner: ctx.github.org, repo: ctx.fixture.targetName };
  const found = await github.asInstallation('GET /repos/{owner}/{repo}', params);
  if (found.status === 404) {
    log(`GitHub repository ${target} is already gone`);
    return false;
  }
  if (found.status !== 200) {
    throw new Error(`Cannot read GitHub repository ${target} (HTTP ${found.status})`);
  }
  // Never delete something that is not what the migration of the fixture creates.
  const repo = asRecord(found.json);
  const description = String(repo.description ?? '');
  const homepage = String(repo.homepage ?? '');
  if (description !== ctx.fixture.description || homepage !== ctx.fixture.website) {
    throw new Error(
      `Refusing to delete GitHub repository ${target}: its description ("${description}") or homepage ("${homepage}") is not the fixture's ("${ctx.fixture.description}", "${ctx.fixture.website}"). If it is the test's repository, delete it by hand.`,
    );
  }
  const removed = await github.asInstallation('DELETE /repos/{owner}/{repo}', params);
  if (removed.status === 204) {
    log(`deleted GitHub repository ${target}`);
    return true;
  }
  if (removed.status === 404) {
    log(`GitHub repository ${target} is already gone`);
    return false;
  }
  throw new Error(
    `Cannot delete GitHub repository ${target} (HTTP ${removed.status}). The App needs administration:write and the organization must allow deletion by Apps (docs/e2e-setup.md).`,
  );
}

/** Removes the push restriction on `*` (no principals) and the description prefix. */
async function resetSource(
  ctx: E2eContext,
  bitbucket: BitbucketApi,
  log: (line: string) => void,
): Promise<{ restrictionsRemoved: number; descriptionRestored: boolean }> {
  const base = repoPath(ctx);
  let restrictionsRemoved = 0;
  const restrictions = await bitbucket.request('GET', `${base}/branch-restrictions?pagelen=100`);
  if (restrictions.status !== 200) {
    throw new Error(
      `Cannot list the branch restrictions of ${ctx.fixture.slug} (HTTP ${restrictions.status})`,
    );
  }
  for (const row of asArray(asRecord(restrictions.json).values).map(asRecord)) {
    const shape =
      row.kind === 'push' &&
      row.pattern === '*' &&
      asArray(row.users).length === 0 &&
      asArray(row.groups).length === 0;
    if (!shape) continue;
    const gone = await bitbucket.request('DELETE', `${base}/branch-restrictions/${String(row.id)}`);
    if (gone.status !== 204 && gone.status !== 404) {
      throw new Error(`Cannot delete the push restriction ${String(row.id)} (HTTP ${gone.status})`);
    }
    restrictionsRemoved += 1;
    log(`removed the push restriction on * (id ${String(row.id)})`);
  }

  // The body holds `description` only (LIF-070, ADR-0222).
  let descriptionRestored = false;
  const repo = await bitbucket.request('GET', base);
  if (repo.status !== 200) {
    throw new Error(`Cannot read Bitbucket repository ${ctx.fixture.slug} (HTTP ${repo.status})`);
  }
  const description = String(asRecord(repo.json).description ?? '');
  if (MIGRATED_PREFIX.test(description)) {
    const restored = await bitbucket.request('PUT', base, {
      description: description.replace(MIGRATED_PREFIX, ''),
    });
    if (restored.status !== 200) {
      throw new Error(
        `Cannot restore the description of ${ctx.fixture.slug} (HTTP ${restored.status})`,
      );
    }
    descriptionRestored = true;
    log('removed the [MIGRATED → …] description prefix');
  }
  return { restrictionsRemoved, descriptionRestored };
}
