import { createBuiltinRegistry } from '@git-migrator/registry';
import { describe, expect, it } from 'vitest';
import { ledgerSafe, recoverOpenIntents } from './facets.ts';
import type { MigrationContext } from './services.ts';

const hook = (n: number, url: string) => ({
  key: `https://hooks.example#${String(n).repeat(16)}`,
  url,
  events: ['push'],
  active: true,
});
const SECRET_URLS = [
  'https://user:pw@hooks.example/a/ghp_abcdef?token=s3cr3t',
  'https://hooks.example/b/ghp_other?token=t0ken',
];

/** [FAC-WEB-002] [LIF-045] a lost create of org webhooks is recovered per hook, with no credential stored. */
describe('recovering a lost organization webhook write', () => {
  it('[FAC-WEB-002] [LIF-045] recovers both hooks by key and the ledger never holds a URL credential', async () => {
    const before = { hooks: [] };
    const desired = { hooks: [hook(1, SECRET_URLS[0] ?? ''), hook(2, SECRET_URLS[1] ?? '')] };
    const confirmed: { id: string; outcome: string; actual?: Record<string, unknown> }[] = [];
    const ctx = {
      ledger: {
        openIntents: async () => [
          {
            id: 'umbrella',
            facetKey: 'org-webhooks',
            resourceRef: { kind: 'facet-apply', meant: ledgerSafe('org-webhooks', desired) },
            before: ledgerSafe('org-webhooks', before),
          },
        ],
        confirm: async (id: string, outcome: string, actual?: Record<string, unknown>) => {
          confirmed.push({ id, outcome, ...(actual ? { actual } : {}) });
        },
      },
      services: {
        registry: createBuiltinRegistry(),
        db: { $queryRaw: async () => [] },
      },
      run: { id: 'r' },
      step: { id: 's' },
      runLog: async () => undefined,
    } as unknown as MigrationContext;
    const target = {
      driver: {},
      connection: {
        facets: { 'org-webhooks': { read: async () => ({ data: desired }) } },
      },
    };
    await recoverOpenIntents(ctx, target as never, { scope: 'endpoint' } as never);
    const recovered = confirmed.find((c) => c.actual);
    expect(recovered?.outcome).toBe('applied');
    expect(recovered?.actual).toBeDefined();
    const keys = desired.hooks.map((h) => h.key);
    expect(((recovered?.actual ?? {}) as { paths?: string[] }).paths).toEqual(
      keys.flatMap((k) => ['active', 'events', 'key', 'url'].map((f) => `/hooks[key=${k}]/${f}`)),
    );
    expect(JSON.stringify(confirmed)).not.toMatch(/ghp_|pw@|token=|s3cr3t|t0ken/);
  });
});
