import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBLEMS } from '@git-migrator/api';
import { migrateAuthSchema } from '@git-migrator/auth';
import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ApiRuntime,
  ApiRuntimeUnavailableError,
  buildApiRuntime,
  closeAll,
  closeApiRuntime,
  getApiRuntime,
  setApiRuntime,
} from './api.ts';

const messages = JSON.parse(
  readFileSync(new URL('../../messages/en.json', import.meta.url), 'utf8'),
) as { problem: Record<string, string> };

let t: TestDatabase;
let dir: string;
let env: Record<string, string>;

beforeAll(async () => {
  t = await createTestDatabase('gm_t021m_');
  await migrateAuthSchema(t.connectionString);
  dir = mkdtempSync(join(tmpdir(), 'gm-web-'));
  const file = join(dir, 'config.yaml');
  writeFileSync(
    file,
    `environment: test
publicUrl: http://localhost:3000
postgres: { host: 127.0.0.1, port: 5432, database: ${t.name}, user: git_migrator, sslmode: disable }
auth:
  entra: { tenantId: "11111111-2222-3333-4444-555555555555" }
  roleMappings:
    - { method: entra, claim: roles, value: "GitMigrator.Admin", role: admin }
`,
  );
  env = {
    GM_CONFIG_FILE: file,
    GM_ENVIRONMENT: 'test',
    POSTGRES_PASSWORD: 'git_migrator',
    BETTER_AUTH_SECRET: 'fake-better-auth-secret-0000000000000000',
    ENTRA_CLIENT_ID: 'fake',
    ENTRA_CLIENT_SECRET: 'fake',
  };
}, 120_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await t?.drop();
});

describe('[API-001] the Hono app is composed from configuration and mounted in Next.js', () => {
  it('[API-001] buildApiRuntime wires the database, Better Auth and the app', async () => {
    const runtime = buildApiRuntime(env);
    try {
      expect((await runtime.app.request('http://localhost:3000/api/healthz')).status).toBe(200);
      expect((await runtime.app.request('http://localhost:3000/api/readyz')).status).toBe(200);
      const anonymous = await runtime.app.request('http://localhost:3000/api/v1/me');
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('content-type')).toContain('application/problem+json');
    } finally {
      await runtime.close();
    }
  });

  it('[API-001] the route file exports every method handler on the Node.js runtime and serves the app', async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    try {
      const route = await import('../../app/api/[[...route]]/route.ts');
      expect(route.runtime).toBe('nodejs');
      expect(route.dynamic).toBe('force-dynamic');
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const) {
        expect(typeof route[method], method).toBe('function');
      }
      const health = await route.GET(new Request('http://localhost:3000/api/healthz'));
      expect(await health.json()).toEqual({ status: 'ok' });
      const denied = await route.POST(
        new Request('http://localhost:3000/api/model/wave/create', { method: 'POST', body: '{}' }),
      );
      expect(denied.status).toBe(401);
      const server = await import('./api.ts');
      await server.closeApiRuntime();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('[API-011] problem messages for the UI', () => {
  it('[API-011] every problem code has a problem.<code> text in en.json, and none is unused', () => {
    expect(Object.keys(messages.problem).sort()).toEqual(Object.keys(PROBLEMS).sort());
    for (const text of Object.values(messages.problem)) expect(text.length).toBeGreaterThan(10);
  });

  it('[API-001] closeAll runs every step even when one throws, then rethrows the first error', async () => {
    const closed: string[] = [];
    const step = (name: string, fail?: Error) => () => {
      closed.push(name);
      if (fail) throw fail;
    };
    await expect(
      closeAll([
        step('events'),
        step('jobs', new Error('first')),
        step('auth', new Error('second')),
        step('db'),
      ]),
    ).rejects.toThrow('first');
    expect(closed).toEqual(['events', 'jobs', 'auth', 'db']);
  });
});

describe('[DEP-002] one API runtime per web process', () => {
  it('[DEP-002] the entrypoint and the Next.js bundle share the runtime, and the entrypoint closes it', async () => {
    const close = vi.fn(async () => undefined);
    const runtime = { app: {}, config: {}, close } as unknown as ApiRuntime;
    setApiRuntime(runtime);
    try {
      expect(getApiRuntime()).toBe(runtime);
      // The Next.js server bundle holds its own copy of this module; it must see the same runtime.
      vi.resetModules();
      const bundled = await import('./api.ts');
      expect(bundled.getApiRuntime()).toBe(runtime);
    } finally {
      await closeApiRuntime();
    }
    expect(close).toHaveBeenCalledOnce();
    // Closed and forgotten: a second close does nothing.
    await closeApiRuntime();
    expect(close).toHaveBeenCalledOnce();
  });

  it('[DEP-002][DEP-030] after shutdown closed it, the runtime is never rebuilt', async () => {
    // A valid environment, so a lazy build would succeed if it were attempted.
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    try {
      setApiRuntime({ app: {}, config: {}, close: async () => undefined } as unknown as ApiRuntime);
      await closeApiRuntime();
      expect(() => getApiRuntime()).toThrow(ApiRuntimeUnavailableError);
      expect(() => getApiRuntime()).toThrow(/closed/);
      // The Next.js bundle's copy of the module sees the same marker.
      vi.resetModules();
      const bundled = await import('./api.ts');
      expect(() => bundled.getApiRuntime()).toThrow(/closed/);
      // A later close is still harmless.
      await closeApiRuntime();
      expect(() => getApiRuntime()).toThrow(/closed/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
