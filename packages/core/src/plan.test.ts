import { describe, expect, it } from 'vitest';
import {
  buildPlan,
  ENDPOINT_STEP_TEMPLATE,
  type ExtraFinding,
  type FacetCapability,
  type FacetDefinition,
  FacetRegistry,
  type FacetTranslation,
  PlanError,
  type PlanInput,
  REPOSITORY_STEP_TEMPLATE,
  resolveRoutePolicies,
  type StepTemplate,
  type TranslationResult,
  translateAll,
} from './index.ts';

const build = (i: Omit<PlanInput, 'targetCaps'> & Partial<Pick<PlanInput, 'targetCaps'>>) =>
  buildPlan({ targetCaps: {}, ...i });

// Two synthetic facets, defined here only. `beta` depends on `alpha`.
type Doc = { v: number; items?: { id: string }[] };

const result = (d: Doc): TranslationResult<Doc> => ({
  desired: d,
  decisions: [],
  blockers: [],
  preTasks: [],
  postTasks: [],
  warnings: [],
});

function facet(key: string, over: Partial<FacetDefinition<Doc>> = {}): FacetDefinition<Doc> {
  return {
    key,
    scope: 'repository',
    schemaVersion: 1,
    schema: { parse: (d) => d as Doc },
    compareMode: 'full',
    collections: [{ path: '/items', key: 'id' }],
    dependsOn: [],
    inScope: true,
    normalize: (d) => d,
    translate: (s) => result(s),
    compare: () => [],
    findingCodes: {
      [`${key}.accept-lossy`]: { kind: 'pre', completion: 'accept' },
      [`${key}.block`]: { kind: 'blocker' },
      [`${key}.ask`]: { kind: 'pre', completion: 'resolution' },
      [`${key}.later`]: { kind: 'post', completion: 'manual' },
      [`${key}.check`]: { kind: 'post', completion: 'parity' },
      [`${key}.fyi`]: { kind: 'warning' },
    },
    policyKeys: [`${key}.approx`, `${key}.round`],
    isTaskSatisfied: () => false,
    ...over,
  };
}

const none = { resolve: () => ({ status: 'unmapped' as const }) };
const env = (acceptLossy: string[] = []) => ({
  identities: none,
  groups: none,
  policies: resolveRoutePolicies({ acceptLossy }),
  route: {},
  routeIndex: {},
});
const w: FacetCapability = { read: true, write: true, fields: {} };
const ro: FacetCapability = { read: true, write: false, fields: {} };

const TEMPLATE: StepTemplate = {
  entries: [
    { key: 'start' },
    { facet: 'alpha' },
    { key: 'optional', when: 'opt' },
    { facet: 'beta' },
    { key: 'finish' },
  ],
  appliedElsewhere: ['gamma'],
};

function reg(order: string[] = ['alpha', 'beta']): FacetRegistry {
  const r = new FacetRegistry();
  const defs: Record<string, FacetDefinition<Doc>> = {
    alpha: facet('alpha'),
    beta: facet('beta', { dependsOn: ['alpha'] }),
    gamma: facet('gamma'),
  };
  for (const k of order) r.register(defs[k] as FacetDefinition<Doc>);
  return r;
}

// A translation with one finding of every kind and two lossy decisions.
function noisy(r: FacetRegistry, facetKey: 'alpha' | 'beta', swap = false): FacetTranslation {
  const f = facetKey;
  const patched = new FacetRegistry();
  for (const d of r.ordered()) {
    patched.register(
      d.key === f
        ? {
            ...(d as FacetDefinition<Doc>),
            translate: (s: Doc) => {
              const out: {
                -readonly [K in keyof TranslationResult<Doc>]: TranslationResult<Doc>[K];
              } = result(s);
              const decisions = [
                {
                  path: '/v',
                  fidelity: 'lossy' as const,
                  policyKey: `${f}.approx`,
                  accepted: false as const,
                },
                {
                  path: '/items[id=b]',
                  fidelity: 'lossy' as const,
                  policyKey: `${f}.approx`,
                  accepted: false as const,
                },
                {
                  path: '/items[id=a]',
                  fidelity: 'unsupported' as const,
                  accepted: false as const,
                },
                {
                  path: '/x',
                  fidelity: 'lossy' as const,
                  policyKey: `${f}.round`,
                  accepted: false as const,
                },
              ];
              out.decisions = swap ? decisions.reverse() : decisions;
              const blockers = [{ code: `${f}.block`, paths: ['/v'], params: { n: 1 } }];
              const pre = [
                { code: `${f}.ask`, paths: ['/items[id=b]'], params: { who: 'x' } },
                { code: `${f}.ask`, paths: ['/items[id=a]'], params: { who: 'x' } },
                { code: `${f}.ask`, paths: ['/v'], params: { who: 'y' } },
              ];
              const post = [
                { code: `${f}.later`, paths: ['/items[id=a]'], params: {} },
                { code: `${f}.check`, paths: ['/v'], params: { k: 1 } },
              ];
              const warn = [{ code: `${f}.fyi`, paths: [], params: {} }];
              out.blockers = swap ? blockers : blockers;
              out.preTasks = swap ? pre.reverse() : pre;
              out.postTasks = swap ? post.reverse() : post;
              out.warnings = warn;
              return out;
            },
          }
        : (d as FacetDefinition<Doc>),
    );
  }
  return translateAll(patched, { env: env(), sources: { [f]: { v: 1 } } })
    .translations[0] as FacetTranslation;
}

describe('[LIF-020] plan aggregation', () => {
  it('[LIF-020] [ADP-040] groups findings by kind with tasks, completion and verifiable flags', () => {
    const r = reg();
    const plan = build({
      registry: r,
      translations: [noisy(r, 'alpha')],
      stepTemplate: TEMPLATE,
      targetCaps: { alpha: w },
    });
    expect(plan.blockers.map((i) => [i.code, i.kind, i.fieldPaths])).toEqual([
      ['alpha.block', 'blocker', ['/v']],
    ]);
    expect(plan.preTasks.map((i) => [i.code, i.completion, i.verifiable])).toEqual([
      ['alpha.accept-lossy', 'accept', false],
      ['alpha.accept-lossy', 'accept', false],
      ['alpha.ask', 'resolution', false],
      ['alpha.ask', 'resolution', false],
    ]);
    expect(plan.postTasks.map((i) => [i.code, i.completion, i.verifiable])).toEqual([
      ['alpha.check', 'parity', true],
      ['alpha.later', 'manual', false],
    ]);
    expect(plan.warnings.map((i) => i.code)).toEqual(['alpha.fyi']);
    expect(plan.readiness.readiness).toBe('blocked');
    expect(plan.readiness.counts).toEqual({ blockers: 1, preTasks: 4, postTasks: 2, warnings: 1 });
    expect(plan.readiness.blockerCodes).toEqual(['alpha.block']);
  });

  it('[ADP-040] one accept-lossy task per policy key, paths unioned and fidelity derived', () => {
    const r = reg();
    const plan = build({
      registry: r,
      translations: [noisy(r, 'alpha')],
      stepTemplate: TEMPLATE,
    });
    const accepts = plan.preTasks
      .filter((i) => i.code === 'alpha.accept-lossy')
      .sort((a, b) => String(a.params.policyKey).localeCompare(String(b.params.policyKey)));
    expect(accepts.map((i) => [i.params, i.fieldPaths, i.fidelity])).toEqual([
      [
        { policyKey: 'alpha.approx', paths: ['/items[id=b]', '/v'] },
        ['/items[id=b]', '/v'],
        'lossy',
      ],
      [{ policyKey: 'alpha.round', paths: ['/x'] }, ['/x'], 'lossy'],
    ]);
    // items with no uniform decision have no fidelity; mixed ones neither
    const ask = plan.preTasks.find((i) => i.code === 'alpha.ask' && i.params.who === 'x');
    expect(ask?.fieldPaths).toEqual(['/items[id=a]', '/items[id=b]']);
    expect(ask?.fidelity).toBeUndefined();
    const unsupported = plan.postTasks.find((i) => i.code === 'alpha.later');
    expect(unsupported?.fidelity).toBe('unsupported');
  });

  it('[LIF-020] findings with the same (facet, code, params) merge, as ManualTask identity requires', () => {
    const r = reg();
    const plan = build({
      registry: r,
      translations: [noisy(r, 'alpha')],
      stepTemplate: TEMPLATE,
    });
    const asks = plan.preTasks.filter((i) => i.code === 'alpha.ask');
    expect(asks).toHaveLength(2);
    expect(new Set(asks.map((i) => i.paramsHash)).size).toBe(2);
    expect(asks.every((i) => /^[0-9a-f]{64}$/.test(i.paramsHash))).toBe(true);
  });

  it('[LIF-020] policy-accepted lossy decisions yield Expected Difference drafts, deduplicated and sorted', () => {
    const r = reg();
    const mk = (t: FacetTranslation): FacetTranslation => ({
      ...t,
      expectedDifferences: [...t.expectedDifferences, ...t.expectedDifferences],
    });
    const translated = ['alpha', 'beta'].map((k) => {
      const base = noisy(r, k as 'alpha');
      return mk({
        ...base,
        expectedDifferences: [
          { facetKey: k, path: '/v', reason: 'lossy_accepted', note: `${k}.approx` },
          { facetKey: k, path: '/a', reason: 'unreadable_defaulted', note: 'd' },
        ],
      });
    });
    const plan = build({
      registry: r,
      translations: translated.reverse(),
      stepTemplate: TEMPLATE,
    });
    expect(plan.expectedDifferences.map((d) => [d.facetKey, d.path, d.reason])).toEqual([
      ['alpha', '/a', 'unreadable_defaulted'],
      ['alpha', '/v', 'lossy_accepted'],
      ['beta', '/a', 'unreadable_defaulted'],
      ['beta', '/v', 'lossy_accepted'],
    ]);
  });

  it('[LIF-020] output is deterministic: independent of translation, decision and finding order', () => {
    const r = reg();
    const a = build({
      registry: r,
      translations: [noisy(r, 'alpha'), noisy(r, 'beta')],
      stepTemplate: TEMPLATE,
      targetCaps: { alpha: w, beta: w },
      extraFindings: [
        { kind: 'warning', facetKey: null, code: 'x.one' },
        { kind: 'blocker', facetKey: null, code: 'y.two', params: { a: 1, b: 2 } },
      ],
    });
    const b = build({
      registry: reg(['beta', 'alpha']),
      translations: [noisy(r, 'beta', true), noisy(r, 'alpha', true)],
      stepTemplate: TEMPLATE,
      targetCaps: { beta: w, alpha: w },
      extraFindings: [
        { kind: 'blocker', facetKey: null, code: 'y.two', params: { b: 2, a: 1 } },
        { kind: 'warning', facetKey: null, code: 'x.one' },
      ],
    });
    expect(b).toEqual(a);
    const [sa, sb] = [JSON.stringify(a), JSON.stringify(b)];
    const at = [...sa].findIndex((c, i) => c !== sb[i]);
    expect(sb.slice(Math.max(0, at - 80), at + 80)).toBe(sa.slice(Math.max(0, at - 80), at + 80));
    // order is a dense sequence over the whole plan
    expect(a.items.map((i) => i.order)).toEqual(a.items.map((_, i) => i));
    expect(a.items.map((i) => i.kind).join()).toBe(
      [...a.steps, ...a.blockers, ...a.preTasks, ...a.postTasks, ...a.warnings]
        .map((i) => i.kind)
        .join(),
    );
    // facet-less items come first within their kind, then facets in dependency order
    expect(a.blockers.map((i) => i.facetKey)).toEqual([null, 'alpha', 'beta']);
  });

  it('[LIF-020] extra findings (naming, target, dependency) are validated and grouped', () => {
    const r = reg();
    const plan = build({
      registry: r,
      translations: [],
      extraFindings: [
        { kind: 'pre', facetKey: null, code: 'target.ask', paths: ['/b', '/a'] },
        { kind: 'post', facetKey: 'beta', code: 'beta.later' },
      ],
    });
    expect(plan.preTasks[0]).toMatchObject({
      facetKey: null,
      completion: 'manual',
      verifiable: false,
      fieldPaths: ['/a', '/b'],
    });
    expect(plan.postTasks).toHaveLength(1);
    expect(plan.readiness.readiness).toBe('needs_attention');
    expect(() =>
      build({
        registry: r,
        translations: [],
        extraFindings: [{ kind: 'blocker', facetKey: 'nope', code: 'x.y' }],
      }),
    ).toThrow(PlanError);
    expect(() =>
      build({
        registry: r,
        translations: [],
        extraFindings: [
          { kind: 'blocker', facetKey: null, code: 'x.y', params: { n: Number.NaN } },
        ],
      }),
    ).toThrow(/canonicalized/);
  });

  it('[LIF-004] a plan with only post tasks and warnings is ready; with nothing it is ready', () => {
    const r = reg();
    expect(build({ registry: r, translations: [] }).readiness.readiness).toBe('ready');
    const plan = build({
      registry: r,
      translations: [],
      extraFindings: [
        { kind: 'post', facetKey: null, code: 'p.q' },
        { kind: 'warning', facetKey: null, code: 'p.w' },
      ],
    });
    expect(plan.readiness.readiness).toBe('ready');
    expect(plan.readiness.counts).toMatchObject({ postTasks: 1, warnings: 1 });
  });

  it('[LIF-020] rejects translations for unknown or duplicated facets', () => {
    const r = reg();
    const t = noisy(r, 'alpha');
    expect(() => build({ registry: r, translations: [{ ...t, facetKey: 'zzz' }] })).toThrow(
      /unregistered/,
    );
    expect(() => build({ registry: r, translations: [t, t] })).toThrow(/two translations/);
  });
});

describe('[LIF-040] steps', () => {
  const r = reg(['alpha', 'beta', 'gamma']);
  const tr = (...keys: string[]) =>
    translateAll(r, { env: env(), sources: Object.fromEntries(keys.map((k) => [k, { v: 1 }])) })
      .translations;

  it('[LIF-040] steps follow the template order; conditional entries need their flag', () => {
    const base = {
      registry: r,
      translations: tr('alpha', 'beta'),
      stepTemplate: TEMPLATE,
      targetCaps: { alpha: w, beta: w },
    };
    expect(build(base).steps.map((s) => [s.code, s.facetKey])).toEqual([
      ['start', null],
      ['facet.alpha.apply', 'alpha'],
      ['facet.beta.apply', 'beta'],
      ['finish', null],
    ]);
    expect(build({ ...base, flags: new Set(['opt']) }).steps.map((s) => s.code)).toEqual([
      'start',
      'facet.alpha.apply',
      'optional',
      'facet.beta.apply',
      'finish',
    ]);
  });

  it('[LIF-040] a facet gets an apply step only if translated, in scope and writable on the target', () => {
    const codes = (input: Partial<Parameters<typeof buildPlan>[0]>) =>
      build({
        registry: r,
        translations: tr('alpha', 'beta'),
        stepTemplate: TEMPLATE,
        ...input,
      }).steps.map((s) => s.code);
    expect(codes({ targetCaps: { alpha: w, beta: ro } })).toEqual([
      'start',
      'facet.alpha.apply',
      'finish',
    ]);
    expect(codes({})).toEqual(['start', 'finish']);
    expect(codes({ translations: tr('beta'), targetCaps: { alpha: w, beta: w } })).toEqual([
      'start',
      'facet.beta.apply',
      'finish',
    ]);
    const detect = new FacetRegistry().register(
      facet('alpha', { inScope: false, policyKeys: [], findingCodes: {} }),
    );
    const t = translateAll(detect, { env: env(), sources: { alpha: { v: 1 } } }).translations;
    expect(
      build({
        registry: detect,
        translations: t,
        stepTemplate: TEMPLATE,
        targetCaps: { alpha: w },
      }).steps.map((s) => s.code),
    ).toEqual(['start', 'finish']);
  });

  it('[LIF-040] a writable facet that no step applies is an error; appliedElsewhere is exempt', () => {
    const only: StepTemplate = { entries: [{ key: 'start' }], appliedElsewhere: [] };
    expect(() =>
      build({
        registry: r,
        translations: tr('alpha'),
        stepTemplate: only,
        targetCaps: { alpha: w },
      }),
    ).toThrow(/no step applies it/);
    expect(
      build({
        registry: r,
        translations: tr('gamma'),
        stepTemplate: TEMPLATE,
        targetCaps: { gamma: w },
      }).steps.map((s) => s.code),
    ).toEqual(['start', 'finish']);
  });

  it('[LIF-040] template problems and dependency order violations are errors', () => {
    const dup: StepTemplate = { entries: [{ key: 'a' }, { key: 'a' }], appliedElsewhere: [] };
    expect(() => build({ registry: r, translations: [], stepTemplate: dup })).toThrow(/twice/);
    const wrong: StepTemplate = {
      entries: [{ facet: 'beta' }, { facet: 'alpha' }],
      appliedElsewhere: [],
    };
    expect(() =>
      build({
        registry: r,
        translations: tr('alpha', 'beta'),
        stepTemplate: wrong,
        targetCaps: { alpha: w, beta: w },
      }),
    ).toThrow(/before its dependency alpha/);
    // an unrelated order is fine when the dependency has no step
    expect(
      build({
        registry: r,
        translations: tr('beta'),
        stepTemplate: wrong,
        targetCaps: { beta: w },
      }).steps,
    ).toHaveLength(1);
  });

  it('[LIF-040] [LIF-081] the built-in templates list each step once, in spec order', () => {
    const repo = REPOSITORY_STEP_TEMPLATE.entries.map((e) =>
      'facet' in e ? `facet.${e.facet}.apply` : e.key,
    );
    expect(repo).toEqual([
      'preflight',
      'git.prepare',
      'target.ensure-repository',
      'target.lift-protection',
      'git.push-lfs',
      'git.push-refs',
      'facet.repository-settings.apply',
      'facet.merge-settings.apply',
      'facet.access-control.apply',
      'facet.environments.apply',
      'facet.variables.apply',
      'facet.deploy-keys.apply',
      'change-requests.open',
      'facet.branch-rules.apply',
      'facet.webhooks.apply',
      'overlays.apply',
      'verify',
      'source.read-only',
    ]);
    expect(ENDPOINT_STEP_TEMPLATE.entries.map((e) => ('facet' in e ? e.facet : e.key))).toEqual([
      'members',
      'teams',
      'org-variables',
      'org-webhooks',
      'verify',
    ]);
    const plan = build({
      registry: new FacetRegistry(),
      translations: [],
      flags: new Set(['sourceReadOnly', 'liftProtection']),
    });
    expect(plan.steps.map((s) => s.code)).toEqual([
      'preflight',
      'git.prepare',
      'target.ensure-repository',
      'target.lift-protection',
      'git.push-lfs',
      'git.push-refs',
      'verify',
      'source.read-only',
    ]);
  });
});

describe('[LIF-020] review round 1: extra findings and caps', () => {
  const r = reg();
  const extra = (f: Partial<ExtraFinding>) =>
    build({
      registry: r,
      translations: [],
      extraFindings: [{ kind: 'post', facetKey: 'alpha', code: 'alpha.check', ...f }],
    });

  it('[LIF-020] a facet-attributed finding takes completion and verifiable from the declaration', () => {
    const plan = extra({});
    expect(plan.postTasks[0]).toMatchObject({ completion: 'parity', verifiable: true });
    expect(extra({ code: 'alpha.later' }).postTasks[0]).toMatchObject({
      completion: 'manual',
      verifiable: false,
    });
  });

  it('[LIF-020] undeclared codes, wrong prefix, wrong kind and the engine-owned code are rejected', () => {
    expect(() => extra({ code: 'alpha.nope' })).toThrow(PlanError);
    expect(() => extra({ code: 'beta.check' })).toThrow(/not declared/);
    expect(() => extra({ kind: 'blocker' })).toThrow(/declared as post/);
    expect(() => extra({ kind: 'pre', code: 'alpha.accept-lossy' })).toThrow(/engine/);
  });

  it('[LIF-040] targetCaps is required when translating', () => {
    const t = noisy(r, 'alpha');
    expect(() => buildPlan({ registry: r, translations: [t] } as unknown as PlanInput)).toThrow(
      /targetCaps is required/,
    );
  });
});
