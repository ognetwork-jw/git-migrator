import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, resolveConfig } from '@git-migrator/config';
import { createDb } from '@git-migrator/db';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectionStringFor,
  environmentIsExplicit,
  runMigrate,
  runReset,
  runSeed,
  toConfigSnapshot,
} from './db-commands.ts';

const YAML = `
environment: test
endpoints:
  - id: bitbucket-main
    provider: bitbucket-cloud
    options: { workspace: acme }
  - id: github-main
    provider: github
    options: { org: acme-org, appId: 1, installationId: 2 }
routes:
  - id: bb-to-gh
    source: bitbucket-main
    target: github-main
    targetNamespace: acme-org
`;

const configFor = (t: TestDatabase, extra = ''): Config => {
  const url = new URL(t.connectionString);
  return resolveConfig({
    text: `${YAML}${extra}`,
    env: {
      GM_POSTGRES_HOST: url.hostname,
      GM_POSTGRES_PORT: url.port,
      GM_POSTGRES_DATABASE: t.name,
      GM_POSTGRES_USER: decodeURIComponent(url.username),
      GM_POSTGRES_SSLMODE: 'disable',
    },
  });
};
const envFor = (t: TestDatabase) => ({
  GM_ENVIRONMENT: 'test',
  POSTGRES_PASSWORD: decodeURIComponent(new URL(t.connectionString).password),
});

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('gm_t010_');
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

describe('migrate entrypoint (DATA-030)', () => {
  it('[DATA-010] builds the connection string from config postgres.* and POSTGRES_PASSWORD', () => {
    const config = resolveConfig({ env: {} });
    expect(connectionStringFor(config, { POSTGRES_PASSWORD: 'pw' })).toBe(
      'postgresql://git_migrator:pw@localhost:5432/git_migrator?sslmode=require',
    );
  });

  it('[DATA-030] maps configured Endpoints and Routes to hashed sync specs', () => {
    const snapshot = toConfigSnapshot(configFor(t));
    expect(snapshot.endpoints.map((e) => [e.id, e.providerType])).toEqual([
      ['bitbucket-main', 'bitbucket-cloud'],
      ['github-main', 'github'],
    ]);
    expect(snapshot.routes[0]).toMatchObject({
      id: 'bb-to-gh',
      sourceEndpointId: 'bitbucket-main',
      targetEndpointId: 'github-main',
      targetNamespacePath: 'acme-org',
      sourcePostAction: 'read-only',
    });
    expect(snapshot.routes[0]?.configHash).toMatch(/^[0-9a-f]{64}$/);
    const changed = toConfigSnapshot(
      resolveConfig({
        text: YAML.replace('acme-org\n', 'other-org\n').replace(
          'targetNamespace: acme-org',
          'targetNamespace: other-org',
        ),
        env: {},
      }),
    );
    expect(changed.routes[0]?.configHash).not.toBe(snapshot.routes[0]?.configHash);
  });

  it('[DATA-030] runs steps 1, 2 and 5 and can run again', async () => {
    const first = await runMigrate(configFor(t), envFor(t));
    expect(first.endpoints.created).toBe(2);
    expect(first.routes.created).toBe(1);
    const second = await runMigrate(configFor(t), envFor(t));
    expect(second.endpoints).toMatchObject({ created: 0, updated: 0 });
    expect(second.routes).toMatchObject({ created: 0, updated: 0 });
  }, 120_000);

  it('[DATA-040] seeds dev data after the migrate and refuses production', async () => {
    const seeded = await runSeed(configFor(t), envFor(t));
    expect(seeded).toEqual({ actors: 3, wave: true, allowlistEntry: true });
    const production = resolveConfig({
      text: 'environment: production\npublicUrl: https://gm.example.test\nauth: { entra: { tenantId: x } }',
      env: {},
    });
    await expect(runSeed(production, {})).rejects.toThrow(/production/);
    await expect(runReset(production, {})).rejects.toThrow(/production/);
  });

  it('[DATA-030] reset drops and recreates the database, then migrates it', async () => {
    const config = configFor(t);
    const before = createDb({ connectionString: t.connectionString, poolMax: 1 });
    expect(await before.privileged.actor.count()).toBe(3);
    await before.close();
    const result = await runReset(config, envFor(t));
    expect(result.routes.created).toBe(1);
    const after = createDb({ connectionString: t.connectionString, poolMax: 1 });
    try {
      expect(await after.privileged.actor.count()).toBe(0);
      expect(await after.privileged.route.count()).toBe(1);
    } finally {
      await after.close();
    }
  }, 120_000);
});

describe('seed and reset guards', () => {
  const dev = resolveConfig({ text: 'environment: test', env: {} });
  const defaulted = resolveConfig({ env: {} });

  it('[DATA-040] refuses a defaulted environment, even one that reads as development', async () => {
    expect(defaulted.environment).toBe('development');
    await expect(runSeed(defaulted, {})).rejects.toThrow(/explicitly/);
    await expect(runReset(defaulted, {})).rejects.toThrow(/explicitly/);
  });

  it('[DATA-040] refuses production even when it is explicit', async () => {
    const production = resolveConfig({
      text: 'environment: production\npublicUrl: https://gm.example.test\nauth: { entra: { tenantId: x } }',
      env: {},
    });
    await expect(runSeed(production, { GM_ENVIRONMENT: 'production' })).rejects.toThrow(
      /test and e2e only/,
    );
    await expect(runReset(production, { GM_ENVIRONMENT: 'production' })).rejects.toThrow(
      /test and e2e only/,
    );
  });

  it('[DATA-040] sees an environment set by GM_ENVIRONMENT or a key in the config file, not a default', () => {
    expect(environmentIsExplicit({})).toBe(false);
    expect(environmentIsExplicit({ GM_ENVIRONMENT: 'test' })).toBe(true);
    expect(environmentIsExplicit({ GM_CONFIG_FILE: 'c.yaml' }, () => 'environment: test\n')).toBe(
      true,
    );
    expect(environmentIsExplicit({ GM_CONFIG_FILE: 'c.yaml' }, () => 'publicUrl: x\n')).toBe(false);
    expect(
      environmentIsExplicit({ GM_CONFIG_FILE: 'c.yaml' }, () => {
        throw new Error('unreadable');
      }),
    ).toBe(false);
    expect(dev.environment).toBe('test');
  });
});

describe('the db CLI under plain node (DATA-030, DATA-040, DEV-040)', () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'db-cli.ts');
  let cliDb: TestDatabase;
  let dir: string;
  let file: string;
  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GM_CONFIG_FILE: file,
        POSTGRES_PASSWORD: decodeURIComponent(new URL(cliDb.connectionString).password),
        ...extraEnv,
      },
    });

  beforeAll(async () => {
    cliDb = await createTestDatabase('gm_t010_');
    const url = new URL(cliDb.connectionString);
    dir = mkdtempSync(join(tmpdir(), 'gm-cli-'));
    file = join(dir, 'config.yaml');
    writeFileSync(
      file,
      `${YAML}postgres:\n  host: ${url.hostname}\n  port: ${url.port}\n  database: ${cliDb.name}\n  user: ${decodeURIComponent(url.username)}\n  sslmode: disable\n`,
    );
  }, 120_000);
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await cliDb?.drop();
  });

  it('[DATA-030] "migrate" exits 0 and syncs the configured Route', () => {
    const result = run(['migrate']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^migrate: \{.*"routes":\{"created":1/m);
  }, 120_000);

  it('[DATA-040] "seed" exits 0', () => {
    const result = run(['seed']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"actors":3');
  }, 120_000);

  it('[DATA-040] "reset" needs --yes', () => {
    const refused = run(['reset']);
    expect(refused.status).toBe(64);
    expect(refused.stderr).toContain('--yes');
    const ok = run(['reset', '--yes']);
    expect(ok.status, ok.stderr).toBe(0);
  }, 120_000);

  it('[DATA-040] "seed" refuses when the environment is only defaulted', () => {
    writeFileSync(file, readNoEnv(file));
    const result = run(['seed']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('explicitly');
  }, 60_000);

  it('[DEP-003] SIGTERM during "migrate" removes the temporary copy and leaves no child running', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gm-sig-'));
    try {
      const child = spawn(process.execPath, [cli, 'migrate'], {
        env: {
          PATH: process.env.PATH ?? '',
          GM_CONFIG_FILE: file,
          POSTGRES_PASSWORD: decodeURIComponent(new URL(cliDb.connectionString).password),
          TMPDIR: root,
        },
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
      const deadline = Date.now() + 60_000;
      while (!readdirSync(root).some((f) => f.startsWith('gm-migrate-'))) {
        if (Date.now() > deadline) throw new Error('the migration working copy never appeared');
        await new Promise((r) => setTimeout(r, 10));
      }
      child.kill('SIGTERM');
      const code = await exited;
      expect(code).not.toBe(0);
      expect(readdirSync(root)).toEqual([]);
      expect(spawnSync('pgrep', ['-f', root], { encoding: 'utf8' }).stdout.trim()).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('prints usage for an unknown command', () => {
    expect(run(['bogus']).status).toBe(64);
  });
});

function readNoEnv(path: string): string {
  const text = readFileSync(path, 'utf8');
  return text.replace(/^environment:.*\n/m, '');
}
