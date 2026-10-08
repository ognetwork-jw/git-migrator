import {
  CANONICAL_EVENTS,
  type CanonicalEvent,
  type Webhook,
  webhookKey,
} from '@git-migrator/canonical';
import {
  compareFacet,
  type FacetCapability,
  FacetRegistry,
  resolveRoutePolicies,
  satisfiedTasks,
  type TranslateEnvironment,
  translateFacet,
} from '@git-migrator/core';
import { describe, expect, it } from 'vitest';
import {
  COARSE_EVENTS,
  matchesAllowlist,
  mergeDuplicateWebhooks,
  webhooksDefinition,
} from './index.ts';

const registry = new FacetRegistry().register(webhooksDefinition);
const unresolved = { resolve: () => ({ status: 'unmapped' as const }) };

function env(
  opts: { allowlist?: string[]; enabled?: boolean; acceptLossy?: string[] } = {},
): TranslateEnvironment {
  return {
    identities: unresolved,
    groups: unresolved,
    policies: resolveRoutePolicies({
      ...(opts.enabled === undefined ? {} : { webhookAllowlistEnabled: opts.enabled }),
      ...(opts.acceptLossy === undefined ? {} : { acceptLossy: opts.acceptLossy }),
    }),
    route: { webhookAllowlist: opts.allowlist ?? ['https://ci.example.test/**'] },
    routeIndex: {},
  };
}

const URL_OK = 'https://ci.example.test/hooks/build?token=abc';
const URL_OTHER = 'https://chat.example.test/in/xyz';

function hook(url: string, over: Partial<Webhook> = {}): Webhook {
  return {
    key: webhookKey(url),
    url,
    events: ['push'],
    active: true,
    hasSecret: false,
    verifyTls: true,
    ...over,
  };
}

const translate = (hooks: Webhook[], e = env(), targetCaps?: FacetCapability) =>
  translateFacet(registry, 'webhooks', { hooks }, { env: e, targetCaps });
const desiredHooks = (t: { desired: unknown }) => (t.desired as { hooks: Webhook[] }).hooks;

describe('webhooks event mapping rows (FAC-WEB-001)', () => {
  const exact: CanonicalEvent[] = ['push', 'repo.updated', 'repo.fork', 'issue.any'];
  it.each(CANONICAL_EVENTS.map((e) => [e]))('[FAC-WEB-001] %s is kept in desired', (event) => {
    const t = translate([hook(URL_OK, { events: [event] })]);
    expect(desiredHooks(t)[0]?.events).toEqual([event]);
    const path = `/hooks[key=${webhookKey(URL_OK)}]/events`;
    const decision = t.decisions.find((d) => d.path === path);
    if (exact.includes(event)) expect(decision).toBeUndefined();
    else expect(decision?.fidelity).toBe('translated');
  });

  it('[FAC-WEB-001] the coarse events are exactly the pull request, review and status events', () => {
    expect([...COARSE_EVENTS].sort()).toEqual(
      CANONICAL_EVENTS.filter((e) => !exact.includes(e)).sort(),
    );
  });

  it('[FAC-WEB-001] an event the target cannot receive is dropped as lossy webhooks.event-dropped', () => {
    const caps: FacetCapability = {
      read: true,
      write: true,
      fields: { '/hooks/events': { kind: 'constrained', constraint: 'only:push,repo.fork' } },
    };
    const hooks = [hook(URL_OK, { events: ['push', 'issue.any'] })];
    const t = translate(hooks, env(), caps);
    expect(desiredHooks(t)[0]?.events).toEqual(['push']);
    expect(t.decisions[0]).toMatchObject({
      fidelity: 'lossy',
      policyKey: 'webhooks.event-dropped',
    });
    expect(t.preTasks.map((p) => p.code)).toEqual(['webhooks.accept-lossy']);
    const accepted = translate(hooks, env({ acceptLossy: ['webhooks.event-dropped'] }), caps);
    expect(accepted.preTasks).toEqual([]);
    expect(accepted.decisions[0]?.accepted).toBe('policy');
  });
});

describe('webhooks allowlist (FAC-WEB-002)', () => {
  it('[FAC-WEB-002] a hook matching the allowlist is in desired with no task', () => {
    const t = translate([hook(URL_OK)]);
    expect(desiredHooks(t)).toHaveLength(1);
    expect(t.postTasks).toEqual([]);
  });

  it('[FAC-WEB-002] a hook outside the allowlist is omitted and gets a recreate-manually post task', () => {
    const t = translate([hook(URL_OTHER, { events: ['cr.opened', 'push'] })]);
    expect(desiredHooks(t)).toEqual([]);
    expect(t.postTasks).toHaveLength(1);
    expect(t.postTasks[0]).toMatchObject({
      code: 'webhooks.recreate-manually',
      verifiable: true,
      paths: [`/hooks[key=${webhookKey(URL_OTHER)}]`],
      params: { targetUrl: URL_OTHER, events: ['cr.opened', 'push'] },
    });
  });

  it('[FAC-WEB-002] with an empty allowlist nothing is auto-created, and a disabled allowlist allows all', () => {
    expect(desiredHooks(translate([hook(URL_OK)], env({ allowlist: [] })))).toEqual([]);
    const all = translate([hook(URL_OTHER)], env({ allowlist: [], enabled: false }));
    expect(desiredHooks(all)).toHaveLength(1);
    expect(all.postTasks).toEqual([]);
  });

  it('[FAC-WEB-002] path glob: * stays within a segment, ** crosses segments, characters are literal', () => {
    expect(matchesAllowlist('https://a.test/x/y', ['https://a.test/*'])).toBe(false);
    expect(matchesAllowlist('https://a.test/x', ['https://a.test/*'])).toBe(true);
    expect(matchesAllowlist('https://a.test/x/y?t=1', ['https://a.test/**'])).toBe(true);
    expect(matchesAllowlist('https://a.test/x+y', ['https://a.test/x+y'])).toBe(true);
    expect(matchesAllowlist('https://a.test/xxy', ['https://a.test/x+y'])).toBe(false);
  });

  it('[FAC-WEB-002] a ?, # or backslash in the raw URL cannot smuggle a host past the allowlist', () => {
    const rule = ['https://*.example.com/hook'];
    expect(matchesAllowlist('https://a.example.com/hook', rule)).toBe(true);
    expect(matchesAllowlist('https://evil.com?.example.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://evil.com#.example.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://evil.com\\.example.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://a.example.com\\@evil.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://evil.com/x?y=.example.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://a.example.com/hook\n', rule)).toBe(false);
    expect(matchesAllowlist('https://a.example.com /hook', rule)).toBe(false);
    expect(matchesAllowlist('https://\u0000a.example.com/hook', rule)).toBe(false);
  });

  it('[FAC-WEB-002] userinfo, ports, scheme, case, IDN and trailing slashes are compared structurally', () => {
    const rule = ['https://*.example.com/hook'];
    expect(matchesAllowlist('https://a.example.com@evil.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://evil.com@a.example.com/hook', rule)).toBe(true);
    expect(matchesAllowlist('https://a.example.com:8443/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://a.example.com:443/hook', rule)).toBe(true);
    expect(
      matchesAllowlist('https://a.example.com:8443/hook', ['https://*.example.com:8443/hook']),
    ).toBe(true);
    expect(matchesAllowlist('http://a.example.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('HTTPS://A.EXAMPLE.COM/hook', rule)).toBe(true);
    expect(matchesAllowlist('https://a.example.com/hook/', rule)).toBe(false);
    expect(matchesAllowlist('https://example.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://a.b.example.com/hook', rule)).toBe(false);
    expect(matchesAllowlist('https://x.example.com/hook', ['https://**.example.com/hook'])).toBe(
      false,
    );
    expect(
      matchesAllowlist('https://bücher.example.com/hook', [
        'https://xn--bcher-kva.example.com/hook',
      ]),
    ).toBe(true);
    expect(matchesAllowlist('https://a.example.com/hook', ['not a url'])).toBe(false);
    expect(matchesAllowlist('not a url', rule)).toBe(false);
  });

  it('[FAC-WEB-002] the query is ignored, and a path-glob trick through the query does not match', () => {
    expect(matchesAllowlist('https://a.test/hook?token=1', ['https://a.test/hook'])).toBe(true);
    expect(matchesAllowlist('https://a.test/hook?x=/..', ['https://a.test/hook'])).toBe(true);
    expect(matchesAllowlist('https://a.test/ok/../evil', ['https://a.test/ok/*'])).toBe(false);
    expect(matchesAllowlist('https://a.test/hook?x=/..', ['https://a.test/hook/*'])).toBe(false);
  });

  it('[FAC-WEB-002] a hook whose events are all unsupported is omitted and left to the human', () => {
    const caps: FacetCapability = {
      read: true,
      write: true,
      fields: { '/hooks/events': { kind: 'constrained', constraint: 'only:repo.fork' } },
    };
    const t = translate([hook(URL_OK, { events: ['push'] })], env(), caps);
    expect(desiredHooks(t)).toEqual([]);
    expect(t.postTasks.map((p) => p.code)).toEqual(['webhooks.recreate-manually']);
  });

  it('[FAC-WEB-002] a malformed route allowlist throws', () => {
    expect(() =>
      translateFacet(
        registry,
        'webhooks',
        { hooks: [] },
        { env: { ...env(), route: { webhookAllowlist: 'https://x' } } },
      ),
    ).toThrow(/webhookAllowlist/);
  });

  it('[FAC-WEB-002] recreate-manually is satisfied by a target hook with the same URL and the events', () => {
    const task = {
      code: 'webhooks.recreate-manually',
      params: { targetUrl: URL_OTHER, events: ['push', 'cr.opened'] },
    };
    const target = (events: CanonicalEvent[], url = URL_OTHER) => ({
      hooks: [hook(url, { events })],
    });
    const sat = (t: unknown) => satisfiedTasks(registry, 'webhooks', [task], t, []).length;
    expect(sat(target(['push', 'cr.opened']))).toBe(1);
    // a receiver gets a superset (FAC-WEB-001)
    expect(sat(target(['push', 'cr.opened', 'cr.merged']))).toBe(1);
    expect(sat(target(['push']))).toBe(0);
    expect(sat(target(['push', 'cr.opened'], 'https://other.example.test/h'))).toBe(0);
    expect(sat({ hooks: [] })).toBe(0);
    const bad = { code: task.code, params: { targetUrl: 'not a url', events: [] } };
    expect(satisfiedTasks(registry, 'webhooks', [bad], { hooks: [] }, [])).toEqual([]);
  });
});

describe('webhooks secrets (FAC-WEB-003)', () => {
  const secretHook = hook(URL_OK, { hasSecret: true, active: true });
  const key = webhookKey(URL_OK);

  it('[FAC-WEB-003] a hook with a secret gets a set-secret post task and a translated active', () => {
    const t = translate([secretHook]);
    expect(t.postTasks).toHaveLength(1);
    expect(t.postTasks[0]).toMatchObject({
      code: 'webhooks.set-secret',
      verifiable: true,
      paths: [`/hooks[key=${key}]/hasSecret`],
      params: { key, targetUrlDisplay: 'https://ci.example.test/…', activateAfterSecret: true },
    });
    expect(JSON.stringify(t.postTasks)).not.toContain('token=abc');
    expect(desiredHooks(t)[0]?.active).toBe(false);
    expect(t.decisions.find((d) => d.path === `/hooks[key=${key}]/active`)?.fidelity).toBe(
      'translated',
    );
  });

  it('[FAC-WEB-002] a non-allowlisted hook with a secret appears only as the recreate task', () => {
    const t = translate([hook(URL_OTHER, { hasSecret: true })]);
    expect(t.postTasks.map((p) => p.code)).toEqual(['webhooks.recreate-manually']);
    // The guidance asks for a new secret; the flag is all that is carried.
    expect(t.postTasks[0]?.params).toMatchObject({ hasSecret: true });
    expect(translate([hook(URL_OTHER)]).postTasks[0]?.params).not.toHaveProperty('hasSecret');
  });

  it('[FAC-WEB-003] a hook without a secret gets no set-secret task and no active decision', () => {
    const t = translate([hook(URL_OK)]);
    expect(t.postTasks).toEqual([]);
    expect(t.decisions).toEqual([]);
  });

  it('[FAC-WEB-003] set-secret is satisfied when the target hook has a secret and is active', () => {
    const task = {
      code: 'webhooks.set-secret',
      params: { key, targetUrlDisplay: 'x', activateAfterSecret: true },
    };
    const sat = (h: Partial<Webhook>) =>
      satisfiedTasks(registry, 'webhooks', [task], { hooks: [hook(URL_OK, h)] }, []).length;
    expect(sat({ hasSecret: true, active: true })).toBe(1);
    expect(sat({ hasSecret: true, active: false })).toBe(0);
    expect(sat({ hasSecret: false, active: true })).toBe(0);
    expect(satisfiedTasks(registry, 'webhooks', [task], { hooks: [] }, [])).toEqual([]);
    // inactive on the source: no activation is expected
    const stays = { ...task, params: { ...task.params, activateAfterSecret: false } };
    const inactive = { hooks: [hook(URL_OK, { hasSecret: true, active: false })] };
    expect(satisfiedTasks(registry, 'webhooks', [stays], inactive, [])).toHaveLength(1);
  });

  it('[FAC-WEB-003] parity: only the secret is outstanding before the task, equal after, whatever active is', () => {
    const desired = translate([secretHook]).desired;
    const diffs = (actual: Partial<Webhook>) =>
      compareFacet(registry, 'webhooks', desired, { hooks: [hook(URL_OK, actual)] })?.diffs.map(
        (d) => d.path.split('/').pop(),
      );
    expect(diffs({ hasSecret: false, active: false })).toEqual(['hasSecret']);
    expect(diffs({ hasSecret: true, active: false })).toEqual([]);
    expect(diffs({ hasSecret: true, active: true })).toEqual([]);
  });
});

describe('webhooks compare', () => {
  const desired = { hooks: [hook(URL_OK, { events: ['push', 'cr.opened'] })] };

  it('[FAC-WEB-001] a target that receives a superset of the events is equal', () => {
    const actual = { hooks: [hook(URL_OK, { events: ['push', 'cr.opened', 'cr.merged'] })] };
    expect(compareFacet(registry, 'webhooks', desired, actual)?.status).toBe('equal');
  });

  it('[FAC-WEB-001] a missing event is a difference', () => {
    const actual = { hooks: [hook(URL_OK, { events: ['push'] })] };
    const c = compareFacet(registry, 'webhooks', desired, actual);
    expect(c?.diffs.map((d) => d.path)).toEqual([`/hooks[key=${webhookKey(URL_OK)}]/events`]);
  });

  it('[ADR-0088] a missing hook is reported without the URL, which may carry a credential', () => {
    const c = compareFacet(registry, 'webhooks', desired, { hooks: [] });
    expect(c?.status).toBe('different');
    expect(JSON.stringify(c?.diffs)).not.toContain('token=abc');
    expect(JSON.stringify(c?.diffs)).not.toContain('/hooks/build');
  });

  it('[FAC-WEB-002] a hook only on the target is not drift; verifyTls and active are compared', () => {
    expect(compareFacet(registry, 'webhooks', { hooks: [] }, desired)?.status).toBe('equal');
    const off = compareFacet(registry, 'webhooks', desired, {
      hooks: [hook(URL_OK, { events: ['push', 'cr.opened'], verifyTls: false, active: false })],
    });
    expect(off?.diffs.map((d) => d.path.split('/').pop())).toEqual(['active', 'verifyTls']);
  });
});

describe('webhooks recreated by hand', () => {
  it('[FAC-WEB-002] once recreate-manually is satisfied, parity is equal', () => {
    const t = translate([hook(URL_OTHER, { events: ['push'] })]);
    const task = t.postTasks[0];
    expect(task?.code).toBe('webhooks.recreate-manually');
    const target = { hooks: [hook(URL_OTHER, { events: ['push', 'cr.merged'] })] };
    const open = [{ code: task?.code ?? '', params: task?.params }];
    expect(satisfiedTasks(registry, 'webhooks', open, target, [])).toHaveLength(1);
    expect(compareFacet(registry, 'webhooks', t.desired, target)?.status).toBe('equal');
  });
});

describe('webhooks normalize', () => {
  it('[FAC-WEB] events are a sorted set', () => {
    const doc = { hooks: [hook(URL_OK, { events: ['issue.any', 'push', 'cr.merged'] })] };
    const t = translateFacet(registry, 'webhooks', doc, { env: env() });
    expect((t.source as { hooks: Webhook[] }).hooks[0]?.events).toEqual([
      'cr.merged',
      'issue.any',
      'push',
    ]);
  });
});

describe('webhooks duplicate URLs (ADR-0088)', () => {
  const strip = ({ key: _key, ...rest }: Webhook) => rest;
  const a = hook(URL_OK, { events: ['push'], active: false });
  const b = hook('HTTPS://CI.example.test:443/hooks/build?token=abc', {
    events: ['cr.opened'],
    active: false,
    hasSecret: true,
    verifyTls: false,
  });

  it('[ADR-0088] hooks with the same normalized URL merge into one and are reported as a warning', () => {
    const merged = mergeDuplicateWebhooks([strip(a), strip(b), strip(hook(URL_OTHER))]);
    expect(merged.hooks).toHaveLength(2);
    const one = merged.hooks.find((h) => h.key === webhookKey(URL_OK));
    expect(one).toMatchObject({
      events: ['cr.opened', 'push'],
      active: false,
      hasSecret: true,
      verifyTls: false,
    });
    expect(merged.duplicates).toEqual([{ key: webhookKey(URL_OK), count: 2 }]);
    expect(merged.warnings).toEqual([
      {
        code: 'webhooks.duplicate-url',
        paths: [`/hooks[key=${webhookKey(URL_OK)}]`],
        params: { targetUrlDisplay: 'https://ci.example.test/…', count: 2 },
      },
    ]);
    // the merged document is valid for the facet
    expect(() => translate(merged.hooks)).not.toThrow();
  });

  it('[ADR-0088] the merged url does not depend on the input order, and an invalid URL error hides it', () => {
    const c = strip(hook('https://ci.example.test:443/hooks/build?token=abc'));
    const d = strip(hook('HTTPS://CI.EXAMPLE.TEST/hooks/build?token=abc'));
    const one = mergeDuplicateWebhooks([c, d]).hooks;
    const two = mergeDuplicateWebhooks([d, c]).hooks;
    expect(one).toEqual(two);
    expect(one[0]?.url).toBe('HTTPS://CI.EXAMPLE.TEST/hooks/build?token=abc');
    let error: unknown;
    try {
      mergeDuplicateWebhooks([
        { ...strip(a), url: 'https://secret.example.test:99999999/?token=s3' },
      ]);
    } catch (e) {
      error = e;
    }
    expect(String(error)).toBe('Error: invalid webhook url');
    expect(Object.keys(error as object)).toEqual([]);
  });

  it('[ADR-0088] distinct URLs produce no warning, and the finding code is declared', () => {
    expect(mergeDuplicateWebhooks([strip(a), strip(hook(URL_OTHER))]).warnings).toEqual([]);
    expect(webhooksDefinition.findingCodes['webhooks.duplicate-url']).toEqual({ kind: 'warning' });
  });
});
