import { type OrgWebhooks, type Webhook, webhookKey } from '@git-migrator/canonical';
import {
  compareFacet,
  type FacetCapability,
  FacetRegistry,
  satisfiedTasks,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import { envOf } from '../endpoint-test-support.ts';
import { orgWebhooksDefinition } from './index.ts';

const registry = new FacetRegistry().register(orgWebhooksDefinition);
const URL_A = 'https://ci.example.com/hooks/a';
const URL_B = 'https://ci.example.com/hooks/b?token=do-not-log';
const hook = (url: string, over: Partial<Webhook> = {}): Webhook => ({
  key: webhookKey(url),
  url,
  events: ['push'],
  active: true,
  hasSecret: false,
  verifyTls: true,
  ...over,
});
const doc = (...hooks: Webhook[]): OrgWebhooks => ({ hooks });

interface Options {
  allowlist?: string[];
  policies?: unknown;
  targetCaps?: FacetCapability;
}
function translate(source: OrgWebhooks, o: Options = {}) {
  return translateFacet(registry, 'org-webhooks', source, {
    env: envOf(
      {},
      {
        route: o.allowlist === undefined ? {} : { webhookAllowlist: o.allowlist },
        policies: o.policies,
      },
    ),
    targetCaps: o.targetCaps,
  });
}
const hooksOf = (t: { desired: unknown }) => (t.desired as OrgWebhooks).hooks;
const hpath = (url: string, rest = '') => `/hooks[key=${webhookKey(url)}]${rest}`;

describe('org-webhooks facet', () => {
  it('[FAC-001] declares the endpoint scope, the key collection and its policy key', () => {
    expect(orgWebhooksDefinition.scope).toBe('endpoint');
    expect(orgWebhooksDefinition.dependsOn).toEqual([]);
    expect(orgWebhooksDefinition.collections).toEqual([{ path: '/hooks', key: 'key' }]);
    expect(orgWebhooksDefinition.sets).toEqual(['/hooks/events']);
    expect(orgWebhooksDefinition.policyKeys).toEqual(['org-webhooks.event-dropped']);
  });

  describe('allowlist (FAC-WEB-002)', () => {
    it('[FAC-WEB-002] an allowlisted hook is created: it stays in desired, with no task', () => {
      const t = translate(doc(hook(URL_A)), { allowlist: ['https://ci.example.com/hooks/*'] });
      expect(hooksOf(t)).toEqual([hook(URL_A)]);
      expect(t.postTasks).toEqual([]);
    });

    it('[FAC-WEB-002] a hook outside the allowlist is omitted and raises recreate-manually with its URL and events', () => {
      const t = translate(doc(hook(URL_A, { events: ['push', 'cr.merged'] })), {
        allowlist: ['https://other.example.com/**'],
      });
      expect(hooksOf(t)).toEqual([]);
      expect(t.postTasks).toEqual([
        expect.objectContaining({
          code: 'org-webhooks.recreate-manually',
          paths: [hpath(URL_A)],
          params: {
            key: webhookKey(URL_A),
            targetUrl: URL_A,
            targetUrlDisplay: 'https://ci.example.com/…',
            events: ['cr.merged', 'push'],
          },
          verifiable: true,
        }),
      ]);
    });

    it('[FAC-WEB-002] with no allowlist configured nothing is created automatically', () => {
      const t = translate(doc(hook(URL_A)));
      expect(hooksOf(t)).toEqual([]);
      expect(t.postTasks.map((p) => p.code)).toEqual(['org-webhooks.recreate-manually']);
    });

    it('[FAC-WEB-002] * stays inside a path segment and ** crosses segments', () => {
      const deep = hook('https://ci.example.com/a/b/c');
      expect(hooksOf(translate(doc(deep), { allowlist: ['https://ci.example.com/*'] }))).toEqual(
        [],
      );
      expect(hooksOf(translate(doc(deep), { allowlist: ['https://ci.example.com/**'] }))).toEqual([
        deep,
      ]);
    });

    it('[FAC-WEB-002] a ?, # or backslash in the raw URL cannot smuggle a host past the allowlist', () => {
      const rule = ['https://*.example.com/hook'];
      const created = (url: string) =>
        hooksOf(translate(doc(hook(url)), { allowlist: rule })).length;
      expect(created('https://a.example.com/hook')).toBe(1);
      expect(created('HTTPS://A.EXAMPLE.COM:443/hook')).toBe(1); // case and default port
      expect(created('https://a.example.com/hook?x=.example.com')).toBe(1); // query ignored
      for (const bad of [
        'https://evil.com?.example.com/hook',
        'https://evil.com#.example.com/hook',
        'https://evil.com\\.example.com/hook',
        'https://a.example.com\\@evil.com/hook',
        'https://a.example.com:8443/hook',
        'http://a.example.com/hook',
        'https://example.com/hook',
      ]) {
        const t = translate(doc(hook(bad)), { allowlist: rule });
        expect(hooksOf(t), bad).toEqual([]);
        expect(
          t.postTasks.map((p) => p.code),
          bad,
        ).toEqual(['org-webhooks.recreate-manually']);
      }
    });

    it('[FAC-WEB-002] a hook whose events are all unsupported is omitted and left to the human', () => {
      const targetCaps: FacetCapability = {
        read: true,
        write: true,
        fields: { '/hooks/events': { kind: 'constrained', constraint: 'only:repo.fork' } },
      };
      const t = translate(doc(hook(URL_A, { events: ['push'] })), {
        allowlist: ['https://ci.example.com/**'],
        targetCaps,
      });
      expect(hooksOf(t)).toEqual([]);
      expect(t.postTasks.map((p) => p.code)).toEqual(['org-webhooks.recreate-manually']);
      expect(t.decisions).toEqual([]);
    });

    it('[FAC-005] when the Route disables the allowlist every hook is created', () => {
      const t = translate(doc(hook(URL_A)), { policies: { webhookAllowlistEnabled: false } });
      expect(hooksOf(t)).toEqual([hook(URL_A)]);
      expect(t.postTasks).toEqual([]);
    });

    it('[FAC-WEB-002] a malformed allowlist is an error, not a silent fallback', () => {
      expect(() => translate(doc(hook(URL_A)), { allowlist: [1 as never] })).toThrow(/translate/);
    });
  });

  describe('secrets (FAC-WEB-003)', () => {
    const allow = ['https://ci.example.com/**'];

    it('[FAC-WEB-003] a hook with a secret is created inactive and raises set-secret without the full URL', () => {
      const t = translate(doc(hook(URL_B, { hasSecret: true, active: true })), {
        allowlist: allow,
      });
      expect(hooksOf(t)[0]).toMatchObject({ hasSecret: true, active: false });
      expect(t.postTasks).toEqual([
        expect.objectContaining({
          code: 'org-webhooks.set-secret',
          paths: [hpath(URL_B, '/hasSecret')],
          params: {
            key: webhookKey(URL_B),
            targetUrlDisplay: 'https://ci.example.com/…',
            activateAfterSecret: true,
          },
        }),
      ]);
      expect(JSON.stringify(t.postTasks)).not.toContain('do-not-log');
      expect(t.decisions).toContainEqual(
        expect.objectContaining({ path: hpath(URL_B, '/active'), fidelity: 'translated' }),
      );
    });

    it('[FAC-WEB-003] a hook that was inactive on the source is not to be activated afterwards', () => {
      const t = translate(doc(hook(URL_A, { hasSecret: true, active: false })), {
        allowlist: allow,
      });
      expect(t.postTasks[0]?.params).toMatchObject({ activateAfterSecret: false });
    });

    it('[FAC-WEB-002] a hook with a secret outside the allowlist raises only the recreate task', () => {
      const t = translate(doc(hook(URL_A, { hasSecret: true })), { allowlist: [] });
      expect(t.postTasks.map((p) => p.code)).toEqual(['org-webhooks.recreate-manually']);
      expect(t.postTasks[0]?.params).toMatchObject({ hasSecret: true });
    });

    it('[FAC-WEB-003] a hook without a secret raises no set-secret task', () => {
      const t = translate(doc(hook(URL_A)), { allowlist: allow });
      expect(t.postTasks).toEqual([]);
    });

    it('[FAC-WEB-003] the secret is never part of a document: hasSecret is a flag only', () => {
      const source = { hooks: [{ ...hook(URL_A), secret: 'placeholder' }] };
      expect(() => translateFacet(registry, 'org-webhooks', source, { env: envOf() })).toThrow();
    });
  });

  describe('events (FAC-WEB-001)', () => {
    const allow = ['https://ci.example.com/**'];

    it('[FAC-WEB-001] exact events (push, repo.*, issue.any) are not recorded as translated', () => {
      const t = translate(
        doc(hook(URL_A, { events: ['push', 'repo.updated', 'repo.fork', 'issue.any'] })),
        {
          allowlist: allow,
        },
      );
      expect(t.decisions).toEqual([]);
    });

    it('[FAC-WEB-001] coarser target events are a translated field', () => {
      for (const event of ['cr.opened', 'cr.comment', 'cr.approved', 'build.status'] as const) {
        const t = translate(doc(hook(URL_A, { events: ['push', event] })), { allowlist: allow });
        expect(t.decisions, event).toEqual([
          { path: hpath(URL_A, '/events'), fidelity: 'translated', accepted: false },
        ]);
      }
    });

    it('[FAC-WEB-001] events the target cannot receive are dropped: lossy org-webhooks.event-dropped', () => {
      const targetCaps: FacetCapability = {
        read: true,
        write: true,
        fields: { '/hooks/events': { kind: 'constrained', constraint: 'only:push,cr.merged' } },
      };
      const t = translate(doc(hook(URL_A, { events: ['push', 'issue.any', 'cr.merged'] })), {
        allowlist: allow,
        targetCaps,
      });
      expect(hooksOf(t)[0]?.events).toEqual(['cr.merged', 'push']);
      expect(t.decisions).toEqual([
        {
          path: hpath(URL_A, '/events'),
          fidelity: 'lossy',
          policyKey: 'org-webhooks.event-dropped',
          accepted: false,
        },
      ]);
      expect(t.preTasks).toEqual([
        expect.objectContaining({
          code: 'org-webhooks.accept-lossy',
          params: {
            policyKey: 'org-webhooks.event-dropped',
            paths: [hpath(URL_A, '/events')],
          },
        }),
      ]);
    });

    it('[FAC-WEB-001] events are sorted and de-duplicated in desired', () => {
      const t = translate(doc(hook(URL_A, { events: ['push', 'cr.merged', 'push'] })), {
        allowlist: allow,
      });
      expect(hooksOf(t)[0]?.events).toEqual(['cr.merged', 'push']);
    });
  });

  it('[GLO-002] logging-safe: finding paths use the hook key, never the URL', () => {
    const t = translate(doc(hook(URL_B, { hasSecret: true })), { allowlist: [] });
    for (const finding of t.postTasks) {
      for (const p of finding.paths) expect(p).not.toContain('do-not-log');
    }
  });

  describe('compare', () => {
    const cmp = (desired: OrgWebhooks, actual: OrgWebhooks | null) =>
      compareFacet(registry, 'org-webhooks', desired, actual);

    it('[LIF-060] equal documents are equal regardless of order and URL', () => {
      expect(cmp(doc(hook(URL_A), hook(URL_B)), doc(hook(URL_B), hook(URL_A)))?.status).toBe(
        'equal',
      );
    });

    it('[FAC-WEB-001] a target that receives a superset of the events is equal', () => {
      expect(
        cmp(
          doc(hook(URL_A, { events: ['cr.merged'] })),
          doc(hook(URL_A, { events: ['cr.merged', 'cr.opened'] })),
        )?.status,
      ).toBe('equal');
      const result = cmp(
        doc(hook(URL_A, { events: ['cr.merged', 'push'] })),
        doc(hook(URL_A, { events: ['push'] })),
      );
      expect(result?.status).toBe('different');
      expect(result?.diffs.map((d) => d.path)).toContain(hpath(URL_A, '/events'));
    });

    it('[FAC-WEB-003] a hook with a secret: only the secret is outstanding, active is not compared', () => {
      const desired = doc(hook(URL_A, { hasSecret: true, active: false }));
      const created = cmp(desired, doc(hook(URL_A, { hasSecret: false, active: false })));
      expect(created?.diffs.map((d) => d.path)).toEqual([hpath(URL_A, '/hasSecret')]);
      for (const active of [true, false]) {
        expect(cmp(desired, doc(hook(URL_A, { hasSecret: true, active })))?.status).toBe('equal');
      }
    });

    it('[FAC-WEB-004] a hook missing from the target is reported', () => {
      expect(cmp(doc(hook(URL_A)), doc())?.status).toBe('different');
    });

    it('[AUTH-061] hooks that exist only on the target are not a difference', () => {
      expect(cmp(doc(hook(URL_A)), doc(hook(URL_A), hook(URL_B)))?.status).toBe('equal');
    });

    it('[LIF-060] an unreadable target is unverifiable', () => {
      expect(cmp(doc(), null)?.status).toBe('unverifiable');
    });
  });

  describe('isTaskSatisfied', () => {
    const done = (code: string, params: unknown, target: OrgWebhooks) =>
      satisfiedTasks(registry, 'org-webhooks', [{ code, params }], target, []).length === 1;

    it('[FAC-WEB-002] recreate-manually is done once a target hook with the URL has the events', () => {
      const params = { targetUrl: URL_A, events: ['push'] };
      expect(
        done(
          'org-webhooks.recreate-manually',
          params,
          doc(hook(URL_A, { events: ['push', 'cr.merged'] })),
        ),
      ).toBe(true);
      expect(done('org-webhooks.recreate-manually', params, doc(hook(URL_B)))).toBe(false);
      expect(
        done('org-webhooks.recreate-manually', params, doc(hook(URL_A, { events: ['cr.merged'] }))),
      ).toBe(false);
    });

    it('[FAC-WEB-003] set-secret is done once the target hook has a secret and, if it should be active, is active', () => {
      const params = { key: webhookKey(URL_A), targetUrlDisplay: 'x', activateAfterSecret: true };
      const set = (p: unknown, t: OrgWebhooks) => done('org-webhooks.set-secret', p, t);
      expect(set(params, doc(hook(URL_A, { hasSecret: true })))).toBe(true);
      expect(set(params, doc(hook(URL_A, { hasSecret: true, active: false })))).toBe(false);
      expect(set(params, doc(hook(URL_A)))).toBe(false);
      const inactive = { ...params, activateAfterSecret: false };
      expect(set(inactive, doc(hook(URL_A, { hasSecret: true, active: false })))).toBe(true);
    });

    it('[FAC-WEB-002] malformed params are never satisfied', () => {
      expect(done('org-webhooks.set-secret', {}, doc(hook(URL_A, { hasSecret: true })))).toBe(
        false,
      );
      expect(done('org-webhooks.set-secret', { targetUrl: 'not a url' }, doc(hook(URL_A)))).toBe(
        false,
      );
    });
  });
});
