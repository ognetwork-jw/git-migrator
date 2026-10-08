import { describe, expect, it } from 'vitest';
import {
  type CompareContext,
  compareFacet,
  diffDocuments,
  type ExpectedDifferenceRecord,
  type FacetDefinition,
  FacetEngineError,
  FacetRegistry,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  hashCanonical,
  resolveRoutePolicies,
  satisfiedTasks,
  type TranslateContext,
  type TranslateEnvironment,
  type TranslationResult,
  translateAll,
  translateFacet,
} from './index.ts';

// -- two synthetic, provider-neutral facets (defined in tests only) -------------------------------

interface Widget {
  title: string;
  color: 'red' | 'blue' | 'teal';
  size: number;
  tags: string[];
  rules: { name: string; level: number; legacy?: boolean }[];
  secret: { name: string; readable: boolean } | null;
}

interface Gadget {
  enabled: boolean;
  label: string;
  mode: 'fast' | 'slow' | 'turbo';
}

function fail(msg: string): never {
  throw new Error(msg);
}

const widgetSchema = {
  parse(data: unknown): Widget {
    const d = data as Widget;
    if (typeof d?.title !== 'string') fail('title must be a string');
    if (!Array.isArray(d.tags) || !Array.isArray(d.rules)) fail('tags and rules are arrays');
    return d;
  },
};

const gadgetSchema = {
  parse(data: unknown): Gadget {
    const d = data as Gadget;
    if (typeof d?.enabled !== 'boolean') fail('enabled must be a boolean');
    return d;
  },
};

const emptyResult = <T>(desired: T): TranslationResult<T> => ({
  desired,
  decisions: [],
  blockers: [],
  preTasks: [],
  postTasks: [],
  warnings: [],
});

const widget: FacetDefinition<Widget> = {
  key: 'widget',
  scope: 'repository',
  schemaVersion: 1,
  schema: widgetSchema,
  compareMode: 'full',
  collections: [{ path: '/rules', key: 'name' }],
  sets: ['/tags'],
  dependsOn: [],
  inScope: true,
  normalize: (d) => ({ ...d, title: d.title.trim() }),
  translate(source, ctx) {
    const r = emptyResult<Widget>({ ...source, rules: [], tags: [] });
    const desired = r.desired;
    // exact: title
    // translated: tags are lowercased (lossless mapping)
    desired.tags = source.tags.map((t) => t.toLowerCase());
    if (source.tags.some((t) => t !== t.toLowerCase())) {
      r.decisions.push({ path: '/tags', fidelity: 'translated', accepted: false });
    }
    // lossy: teal -> blue
    if (source.color === 'teal') {
      desired.color = 'blue';
      r.decisions.push({
        path: '/color',
        fidelity: 'lossy',
        policyKey: 'widget.teal-as-blue',
        accepted: false,
      });
    }
    // lossy: size capped at the target's limit
    if (source.size > 10) {
      desired.size = 10;
      r.decisions.push({
        path: '/size',
        fidelity: 'lossy',
        policyKey: 'widget.size-capped',
        accepted: false,
      });
    }
    for (const rule of source.rules) {
      const path = `/rules[name=${rule.name}]`;
      if (rule.name === 'forbidden') {
        r.blockers.push({
          code: 'widget.forbidden-rule',
          paths: [path],
          params: { name: rule.name },
        });
      } else if (rule.legacy === true) {
        r.decisions.push({ path, fidelity: 'unsupported', accepted: false });
        r.postTasks.push({
          code: 'widget.rule-unsupported',
          paths: [path],
          params: { name: rule.name },
        });
      } else {
        desired.rules.push(rule);
      }
    }
    if (source.secret?.readable === false) {
      const known = ctx.route.defaultSecret as string | undefined;
      if (known !== undefined) {
        desired.secret = { name: known, readable: true };
        r.decisions.push({
          path: '/secret',
          fidelity: 'unreadable',
          defaulted: true,
          accepted: false,
          note: 'route default',
        });
      } else {
        r.decisions.push({ path: '/secret', fidelity: 'unreadable', accepted: false });
        r.postTasks.push({
          code: 'widget.supply-secret',
          paths: ['/secret'],
          params: { name: source.secret.name },
        });
      }
    }
    if (source.title === 'warn') r.warnings.push({ code: 'widget.note', paths: [], params: {} });
    return r;
  },
  compare: (d, a) =>
    diffDocuments(d, a, { collections: [{ path: '/rules', key: 'name' }], sets: ['/tags'] }),
  findingCodes: {
    'widget.accept-lossy': { kind: 'pre', completion: 'accept' },
    'widget.forbidden-rule': { kind: 'blocker' },
    'widget.rule-unsupported': { kind: 'post', completion: 'manual' },
    'widget.supply-secret': { kind: 'post', completion: 'parity' },
    'widget.note': { kind: 'warning' },
  },
  policyKeys: ['widget.teal-as-blue', 'widget.size-capped'],
  isTaskSatisfied: (task, target) =>
    task.code === 'widget.supply-secret' && target.secret !== null && target.secret.readable,
};

const gadget: FacetDefinition<Gadget> = {
  key: 'gadget',
  scope: 'repository',
  schemaVersion: 1,
  schema: gadgetSchema,
  compareMode: 'full',
  collections: [],
  dependsOn: ['widget'],
  inScope: true,
  normalize: (d) => d,
  translate(source, ctx) {
    const r = emptyResult<Gadget>({ ...source });
    const dep = ctx.deps.widget;
    if (dep === undefined) {
      r.blockers.push({
        code: 'gadget.dependency-missing',
        paths: [],
        params: { dependency: 'widget' },
      });
      return r;
    }
    r.desired.label = (dep.desired as Widget).title;
    if (source.mode === 'turbo') {
      r.desired.mode = 'fast';
      r.decisions.push({
        path: '/mode',
        fidelity: 'lossy',
        policyKey: 'gadget.turbo-as-fast',
        accepted: false,
      });
    }
    if (!source.enabled)
      r.preTasks.push({ code: 'gadget.needs-input', paths: ['/enabled'], params: {} });
    return r;
  },
  compare: (d, a) => diffDocuments(d, a, { collections: [] }),
  findingCodes: {
    'gadget.accept-lossy': { kind: 'pre', completion: 'accept' },
    'gadget.dependency-missing': { kind: 'blocker' },
    'gadget.needs-input': { kind: 'pre', completion: 'resolution' },
  },
  policyKeys: ['gadget.turbo-as-fast'],
};

const notes: FacetDefinition<{ text: string }> = {
  key: 'notes',
  scope: 'repository',
  schemaVersion: 1,
  schema: { parse: (d) => d as { text: string } },
  compareMode: 'none',
  collections: [],
  dependsOn: [],
  inScope: false,
  normalize: (d) => d,
  translate: (s) => ({
    ...emptyResult(s),
    warnings: [{ code: 'notes.detected', paths: [], params: { length: s.text.length } }],
  }),
  compare: () => [],
  findingCodes: { 'notes.detected': { kind: 'warning' } },
  policyKeys: [],
};

function registry(): FacetRegistry {
  return new FacetRegistry().register(gadget).register(notes).register(widget);
}

function env(
  acceptLossy: string[] = [],
  route: Record<string, unknown> = {},
): TranslateEnvironment {
  const none = { resolve: () => ({ status: 'unmapped' as const }) };
  return {
    identities: none,
    groups: none,
    policies: resolveRoutePolicies({ acceptLossy }),
    route,
    routeIndex: {},
  };
}

const baseWidget = (over: Partial<Widget> = {}): Widget => ({
  title: ' main ',
  color: 'red',
  size: 3,
  tags: ['b', 'a'],
  rules: [
    { name: 'z', level: 1 },
    { name: 'a', level: 2 },
  ],
  secret: null,
  ...over,
});

const ed = (over: Partial<ExpectedDifferenceRecord>): ExpectedDifferenceRecord => ({
  facetKey: 'widget',
  path: '/color',
  reason: 'manual_accepted',
  ...over,
});

const T = (r: FacetRegistry, key: string, source: unknown, input = { env: env() }) =>
  translateFacet(r, key, source, input);

// -- translate harness ------------------------------------------------------------------------

describe('[ADP-031] translate harness', () => {
  it('[ADP-031] [ADP-040] exact fields produce no decision, finding or Expected Difference', () => {
    const t = T(registry(), 'widget', baseWidget());
    expect(t.decisions).toEqual([]);
    expect([t.blockers, t.preTasks, t.postTasks, t.warnings].flat()).toEqual([]);
    expect(t.expectedDifferences).toEqual([]);
    expect(t.overridden).toBe(false);
  });

  it('[ADP-021] [ADP-031] normalizes source and desired: trims, sorts collections and sets', () => {
    const t = T(registry(), 'widget', baseWidget());
    const desired = t.desired as Widget;
    expect(desired.title).toBe('main');
    expect(desired.rules.map((r) => r.name)).toEqual(['a', 'z']);
    expect(desired.tags).toEqual(['a', 'b']);
    expect((t.source as Widget).rules.map((r) => r.name)).toEqual(['a', 'z']);
  });

  it('[ADP-031] is deterministic and independent of source array order, and never mutates its input', () => {
    const a = baseWidget();
    const b = baseWidget({
      tags: ['a', 'b'],
      rules: [
        { name: 'a', level: 2 },
        { name: 'z', level: 1 },
      ],
    });
    const snapshot = JSON.stringify(a);
    const ta = T(registry(), 'widget', a);
    expect(JSON.stringify(a)).toBe(snapshot);
    expect(T(registry(), 'widget', b)).toEqual(ta);
    expect(T(registry(), 'widget', a)).toEqual(ta);
  });

  it('[ADP-040] translated: a lossless mapping keeps its decision and raises no task', () => {
    const t = T(registry(), 'widget', baseWidget({ tags: ['A'] }));
    expect(t.decisions).toEqual([{ path: '/tags', fidelity: 'translated', accepted: false }]);
    expect(t.preTasks).toEqual([]);
  });

  it('[ADP-040] [FAC-005] lossy and unaccepted: one accept-lossy pre task per policy key, sorted', () => {
    const t = T(registry(), 'widget', baseWidget({ color: 'teal', size: 20 }));
    expect(t.decisions.map((d) => [d.path, d.accepted])).toEqual([
      ['/color', false],
      ['/size', false],
    ]);
    expect(t.preTasks).toEqual([
      {
        code: 'widget.accept-lossy',
        paths: ['/size'],
        params: { policyKey: 'widget.size-capped', paths: ['/size'] },
        kind: 'pre',
        verifiable: false,
      },
      {
        code: 'widget.accept-lossy',
        paths: ['/color'],
        params: { policyKey: 'widget.teal-as-blue', paths: ['/color'] },
        kind: 'pre',
        verifiable: false,
      },
    ]);
    expect(t.expectedDifferences).toEqual([]);
    expect((t.desired as Widget).color).toBe('blue');
    expect((t.desired as Widget).size).toBe(10);
  });

  it('[ADP-040] [FAC-005] lossy accepted by policy: no task, one lossy_accepted draft per path', () => {
    const t = T(registry(), 'widget', baseWidget({ color: 'teal' }), {
      env: env(['widget.teal-as-blue']),
    });
    expect(t.decisions).toEqual([
      { path: '/color', fidelity: 'lossy', policyKey: 'widget.teal-as-blue', accepted: 'policy' },
    ]);
    expect(t.preTasks).toEqual([]);
    expect(t.expectedDifferences).toEqual([
      { facetKey: 'widget', path: '/color', reason: 'lossy_accepted', note: 'widget.teal-as-blue' },
    ]);
  });

  it('[FAC-005] a facet cannot accept its own lossy decision', () => {
    const cheat: FacetDefinition<Widget> = {
      ...widget,
      translate(source, ctx) {
        const r = widget.translate(source, ctx);
        return {
          ...r,
          decisions: r.decisions.map((d): FieldDecision => ({ ...d, accepted: 'policy' })),
        };
      },
    };
    const r = new FacetRegistry().register(cheat);
    const t = translateFacet(r, 'widget', baseWidget({ color: 'teal' }), { env: env() });
    expect(t.decisions[0]?.accepted).toBe(false);
    expect(t.preTasks).toHaveLength(1);
  });

  it('[LIF-006] [FAC-005] a migration-scoped lossy_accepted record (done accept task) accepts the decision', () => {
    const accepted = ed({
      reason: 'lossy_accepted',
      migrationId: 'm1',
      note: 'widget.teal-as-blue',
      path: '/color',
    });
    const t = T(registry(), 'widget', baseWidget({ color: 'teal' }), {
      env: env(),
      expectedDifferences: [accepted],
      migrationId: 'm1',
    } as never);
    expect(t.decisions[0]?.accepted).toBe('migration');
    expect(t.preTasks).toEqual([]);
    expect(t.expectedDifferences).toEqual([]);
  });

  it('[LIF-006] route-wide, revoked, wrong-key, wrong-facet and wrong-reason records do not accept', () => {
    const base = {
      reason: 'lossy_accepted' as const,
      migrationId: 'm1',
      note: 'widget.teal-as-blue',
    };
    const others: ExpectedDifferenceRecord[] = [
      ed({ ...base, migrationId: null }),
      ed({ ...base, revokedAt: new Date() }),
      ed({ ...base, note: 'widget.size-capped' }),
      ed({ ...base, facetKey: 'gadget' }),
      ed({ ...base, reason: 'manual_accepted' }),
      ed({ ...base, path: '/size' }),
      ed({ ...base, migrationId: undefined }),
    ];
    for (const other of others) {
      const t = T(registry(), 'widget', baseWidget({ color: 'teal' }), {
        env: env(),
        expectedDifferences: [other],
        migrationId: 'm1',
      } as never);
      expect(t.decisions[0]?.accepted, JSON.stringify(other)).toBe(false);
      expect(t.preTasks).toHaveLength(1);
    }
  });

  it('[LIF-006] when a policy also accepts, the decision is policy-accepted and the route record is drafted', () => {
    const t = T(registry(), 'widget', baseWidget({ color: 'teal' }), {
      env: env(['widget.teal-as-blue']),
      expectedDifferences: [
        ed({ reason: 'lossy_accepted', migrationId: 'm1', note: 'widget.teal-as-blue' }),
      ],
      migrationId: 'm1',
    } as never);
    expect(t.decisions[0]?.accepted).toBe('policy');
    expect(t.expectedDifferences).toHaveLength(1);
  });

  it('[ADP-040] unsupported: the facet-defined post task, nothing else', () => {
    const t = T(
      registry(),
      'widget',
      baseWidget({ rules: [{ name: 'old', level: 1, legacy: true }] }),
    );
    expect(t.decisions).toEqual([
      { path: '/rules[name=old]', fidelity: 'unsupported', accepted: false },
    ]);
    expect(t.postTasks).toEqual([
      {
        code: 'widget.rule-unsupported',
        paths: ['/rules[name=old]'],
        params: { name: 'old' },
        kind: 'post',
        verifiable: false,
      },
    ]);
    expect(t.preTasks).toEqual([]);
    expect((t.desired as Widget).rules).toEqual([]);
  });

  it('[ADP-040] unreadable: a verifiable post task to supply the value, no Expected Difference', () => {
    const t = T(registry(), 'widget', baseWidget({ secret: { name: 's', readable: false } }));
    expect(t.decisions).toEqual([{ path: '/secret', fidelity: 'unreadable', accepted: false }]);
    expect(t.postTasks).toEqual([
      {
        code: 'widget.supply-secret',
        paths: ['/secret'],
        params: { name: 's' },
        kind: 'post',
        verifiable: true,
      },
    ]);
    expect(t.expectedDifferences).toEqual([]);
  });

  it('[ADP-040] [LIF-063] unreadable_defaulted: desired holds the default, an ED is drafted, no task', () => {
    const t = T(registry(), 'widget', baseWidget({ secret: { name: 's', readable: false } }), {
      env: env([], { defaultSecret: 'fallback' }),
    });
    expect((t.desired as Widget).secret).toEqual({ name: 'fallback', readable: true });
    expect(t.postTasks).toEqual([]);
    expect(t.expectedDifferences).toEqual([
      {
        facetKey: 'widget',
        path: '/secret',
        reason: 'unreadable_defaulted',
        note: 'route default',
      },
    ]);
  });

  it('[ADP-030] blockers and warnings are carried with their kind', () => {
    const t = T(
      registry(),
      'widget',
      baseWidget({ title: 'warn', rules: [{ name: 'forbidden', level: 1 }] }),
    );
    expect(t.blockers.map((b) => [b.code, b.kind, b.paths])).toEqual([
      ['widget.forbidden-rule', 'blocker', ['/rules[name=forbidden]']],
    ]);
    expect(t.warnings.map((w) => [w.code, w.kind])).toEqual([['widget.note', 'warning']]);
  });

  it('[ADP-031] [ADP-021] decision and finding paths are canonicalized; a literal * is escaped', () => {
    const f: FacetDefinition<Widget> = {
      ...widget,
      translate: (s) => ({
        ...emptyResult(s),
        decisions: [{ path: '/rules[name=a*]/level', fidelity: 'translated', accepted: false }],
        postTasks: [{ code: 'widget.rule-unsupported', paths: ['/b', '/a', '/a'], params: {} }],
      }),
    };
    const t = translateFacet(new FacetRegistry().register(f), 'widget', baseWidget(), {
      env: env(),
    });
    expect(t.decisions[0]?.path).toBe('/rules[name=a\\*]/level');
    expect(t.postTasks[0]?.paths).toEqual(['/a', '/b']);
  });
});

describe('[ADP-031] the harness rejects facets that break the contract', () => {
  const run = (patch: Partial<FacetDefinition<Widget>>, source: unknown = baseWidget()) =>
    translateFacet(new FacetRegistry().register({ ...widget, ...patch }), 'widget', source, {
      env: env(),
    });
  const returning =
    (patch: Partial<TranslationResult<Widget>>) =>
    (s: Widget): TranslationResult<Widget> => ({ ...emptyResult(s), ...patch });
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(FacetEngineError);
      return (e as FacetEngineError).code;
    }
    return 'no error';
  };

  it('[ADP-031] mutating the input fails (inputs are frozen copies)', () => {
    expect(
      code(() =>
        run({
          translate: (s) => {
            s.tags.push('x');
            return emptyResult(s);
          },
        }),
      ),
    ).toBe('translate_failed');
  });

  it('[ADP-031] an asynchronous translate is rejected', () => {
    expect(code(() => run({ translate: (s) => Promise.resolve(emptyResult(s)) as never }))).toBe(
      'translate_failed',
    );
    expect(code(() => run({ translate: (() => undefined) as never }))).toBe('translate_failed');
  });

  it('[ADP-031] an invalid source or result is reported with its code', () => {
    expect(code(() => run({}, { nope: 1 }))).toBe('invalid_source');
    expect(code(() => run({ translate: returning({ desired: { nope: 1 } as never }) }))).toBe(
      'invalid_result',
    );
    expect(
      code(() =>
        run({
          translate: (s) =>
            emptyResult({
              ...s,
              rules: [
                { name: 'a', level: 1 },
                { name: 'a', level: 2 },
              ],
            }),
        }),
      ),
    ).toBe('invalid_result');
    expect(code(() => run({ translate: returning({ decisions: 3 as never }) }))).toBe(
      'invalid_result',
    );
    expect(code(() => run({ translate: returning({ blockers: null as never }) }))).toBe(
      'invalid_result',
    );
  });

  it('[ADP-040] invalid decisions are rejected', () => {
    const d = (x: Partial<FieldDecision>) =>
      returning({ decisions: [{ path: '/a', fidelity: 'translated', accepted: false, ...x }] });
    expect(code(() => run({ translate: d({ fidelity: 'bogus' as never }) }))).toBe(
      'invalid_decision',
    );
    expect(code(() => run({ translate: returning({ decisions: [null as never] }) }))).toBe(
      'invalid_decision',
    );
    expect(code(() => run({ translate: d({ path: 'no-slash' }) }))).toBe('invalid_decision');
    expect(code(() => run({ translate: d({ path: '' }) }))).toBe('invalid_decision');
    expect(code(() => run({ translate: d({ fidelity: 'lossy' }) }))).toBe('invalid_decision');
    expect(
      code(() => run({ translate: d({ fidelity: 'lossy', policyKey: 'widget.unknown-key' }) })),
    ).toBe('invalid_decision');
    expect(
      code(() => run({ translate: d({ fidelity: 'lossy', policyKey: 'gadget.turbo-as-fast' }) })),
    ).toBe('invalid_decision');
    expect(code(() => run({ translate: d({ policyKey: 'widget.teal-as-blue' }) }))).toBe(
      'invalid_decision',
    );
    expect(code(() => run({ translate: d({ defaulted: true }) }))).toBe('invalid_decision');
    expect(
      code(() =>
        run({
          translate: returning({
            decisions: [
              { path: '/a', fidelity: 'translated', accepted: false },
              { path: '/a', fidelity: 'unsupported', accepted: false },
            ],
          }),
        }),
      ),
    ).toBe('invalid_decision');
    expect(
      code(() =>
        run({
          translate: returning({
            decisions: [{ path: '', fidelity: 'unreadable', defaulted: true, accepted: false }],
          }),
        }),
      ),
    ).toBe('invalid_decision');
  });

  it('[ADP-030] invalid findings are rejected', () => {
    const f = (x: Partial<Finding>, list: 'blockers' | 'postTasks' = 'postTasks') =>
      returning({ [list]: [{ code: 'widget.rule-unsupported', paths: [], params: {}, ...x }] });
    expect(code(() => run({ translate: f({ code: 'widget.undeclared' }) }))).toBe(
      'invalid_finding',
    );
    expect(code(() => run({ translate: f({ code: undefined as never }) }))).toBe('invalid_finding');
    expect(code(() => run({ translate: f({}, 'blockers') }))).toBe('invalid_finding');
    expect(code(() => run({ translate: f({ code: 'widget.accept-lossy' }) }))).toBe(
      'invalid_finding',
    );
    expect(code(() => run({ translate: f({ paths: ['bad'] }) }))).toBe('invalid_finding');
    expect(code(() => run({ translate: f({ paths: 'x' as never }) }))).toBe('invalid_finding');
    expect(code(() => run({ translate: f({ params: [] as never }) }))).toBe('invalid_finding');
    expect(code(() => run({ translate: f({ params: { n: Number.NaN } }) }))).toBe(
      'invalid_finding',
    );
    expect(code(() => run({ translate: f({ verifiable: true }) }))).toBe('invalid_finding');
    expect(
      code(() => run({ translate: f({ code: 'widget.supply-secret', verifiable: false }) })),
    ).toBe('invalid_finding');
    expect(code(() => run({ translate: returning({ postTasks: [null as never] }) }))).toBe(
      'invalid_finding',
    );
  });

  it('[ADP-030] a detect-only facet may only warn', () => {
    const r = new FacetRegistry().register(notes);
    const t = translateFacet(r, 'notes', { text: 'abc' }, { env: env() });
    expect(t.warnings).toHaveLength(1);
    const bad = new FacetRegistry().register({
      ...notes,
      findingCodes: { 'notes.problem': { kind: 'blocker' } },
      translate: (s) => ({
        ...emptyResult(s),
        blockers: [{ code: 'notes.problem', paths: [], params: {} }],
      }),
    });
    expect(code(() => translateFacet(bad, 'notes', { text: '' }, { env: env() }))).toBe(
      'detect_only_violation',
    );
  });

  it('[ADP-030] a detect-only facet may not make lossy decisions either', () => {
    const lossy = new FacetRegistry().register({
      ...notes,
      policyKeys: ['notes.approx'],
      findingCodes: { 'notes.accept-lossy': { kind: 'pre', completion: 'accept' } },
      translate: (s) => ({
        ...emptyResult(s),
        decisions: [
          { path: '/text', fidelity: 'lossy', policyKey: 'notes.approx', accepted: false },
        ],
      }),
    });
    expect(code(() => translateFacet(lossy, 'notes', { text: '' }, { env: env() }))).toBe(
      'detect_only_violation',
    );
  });

  it('[ADP-040] a bad stored Expected Difference pattern is reported, not ignored', () => {
    expect(
      code(() =>
        T(registry(), 'widget', baseWidget({ color: 'teal' }), {
          env: env(),
          migrationId: 'm',
          expectedDifferences: [
            ed({
              reason: 'lossy_accepted',
              migrationId: 'm',
              note: 'widget.teal-as-blue',
              path: '/a/**/b',
            }),
          ],
        } as never),
      ),
    ).toBe('invalid_expected_difference');
  });
});

// -- pair overrides ---------------------------------------------------------------------------

describe('[ADP-032] pair overrides', () => {
  const pair = { source: 'src-a', target: 'dst-b' };
  const reg = () =>
    registry().registerOverride<Widget>({
      ...pair,
      facet: 'widget',
      translate: (s) => ({
        ...emptyResult(s),
        warnings: [{ code: 'widget.note', paths: [], params: { via: 'override' } }],
      }),
    });

  it('[ADP-032] replaces translate for exactly that pair and facet', () => {
    const t = translateFacet(reg(), 'widget', baseWidget(), { env: env(), pair });
    expect(t.overridden).toBe(true);
    expect(t.warnings[0]?.params).toEqual({ via: 'override' });
    for (const other of [
      { source: 'src-a', target: 'dst-c' },
      { source: 'src-x', target: 'dst-b' },
      undefined,
    ]) {
      const d = translateFacet(reg(), 'widget', baseWidget(), { env: env(), pair: other });
      expect(d.overridden).toBe(false);
      expect(d.warnings).toEqual([]);
    }
    const g = translateFacet(
      reg(),
      'gadget',
      { enabled: true, label: '', mode: 'slow' },
      { env: env(), pair },
    );
    expect(g.overridden).toBe(false);
  });

  it('[ADP-032] override output is validated like any translation', () => {
    const r = registry().registerOverride<Widget>({
      ...pair,
      facet: 'widget',
      translate: (s) => ({
        ...emptyResult(s),
        postTasks: [{ code: 'widget.nonsense', paths: [], params: {} }],
      }),
    });
    expect(() => translateFacet(r, 'widget', baseWidget(), { env: env(), pair })).toThrow(
      FacetEngineError,
    );
  });

  it('[ADP-032] translateAll applies the override and lists it via the registry', () => {
    const r = reg();
    const out = translateAll(r, { env: env(), pair, sources: { widget: baseWidget() } });
    expect(out.translations[0]?.overridden).toBe(true);
    expect(r.overrides().map((o) => [o.source, o.target, o.facet])).toEqual([
      ['src-a', 'dst-b', 'widget'],
    ]);
    expect(r.override(pair, 'widget')).toBeDefined();
    expect(r.override(pair, 'gadget')).toBeUndefined();
  });
});

// -- translateAll -----------------------------------------------------------------------------

describe('[ADP-030] translateAll', () => {
  const sources = {
    gadget: { enabled: false, label: '', mode: 'turbo' },
    widget: baseWidget({ title: 'hello' }),
    notes: { text: 'x' },
  };

  it('[ADP-030] translates dependencies first and hands each facet its dependencies translated', () => {
    const { translations, skipped } = translateAll(registry(), { env: env(), sources });
    expect(translations.map((t) => t.facetKey)).toEqual(['notes', 'widget', 'gadget']);
    expect(skipped).toEqual([]);
    const g = translations[2];
    expect((g?.desired as Gadget | undefined)?.label).toBe('hello');
    expect(g?.preTasks.map((t) => t.code)).toEqual(['gadget.needs-input', 'gadget.accept-lossy']);
  });

  it('[ADP-030] a facet without a source is skipped and its dependents see no dependency', () => {
    const { translations, skipped } = translateAll(registry(), {
      env: env(),
      sources: { gadget: sources.gadget },
    });
    expect(skipped).toEqual(['notes', 'widget']);
    expect(translations[0]?.blockers.map((b) => b.code)).toEqual(['gadget.dependency-missing']);
    const undef = translateAll(registry(), { env: env(), sources: { widget: undefined } });
    expect(undef.skipped).toHaveLength(3);
  });

  it('[ADP-030] dependency results given to a facet are frozen and limited to dependsOn', () => {
    let seen: TranslateContext['deps'] | undefined;
    const spy: FacetDefinition<Gadget> = {
      ...gadget,
      translate(s, ctx) {
        seen = ctx.deps;
        expect(() => {
          (ctx.deps as Record<string, unknown>).other = 1;
        }).toThrow();
        return emptyResult({ ...s });
      },
    };
    const r = new FacetRegistry().register(widget).register(spy);
    translateAll(r, { env: env(), sources: { widget: baseWidget(), gadget: sources.gadget } });
    expect(Object.keys(seen ?? {})).toEqual(['widget']);
    // Even an over-eager caller of translateFacet cannot leak unrelated facets.
    const t = translateFacet(r, 'gadget', sources.gadget, {
      env: env(),
      deps: { widget: { source: 1, desired: 2 }, notes: { source: 3, desired: 4 } },
    });
    expect(t.facetKey).toBe('gadget');
    expect(Object.keys(seen ?? {})).toEqual(['widget']);
  });

  it('[ADP-014] capabilities are passed per facet and default to none', () => {
    const caps = { read: true, write: true, fields: {} };
    let got: [unknown, unknown] | undefined;
    const spy: FacetDefinition<Gadget> = {
      ...gadget,
      dependsOn: [],
      translate(s, ctx) {
        got = [ctx.sourceCaps, ctx.targetCaps];
        return emptyResult({ ...s });
      },
    };
    const r = new FacetRegistry().register(spy);
    translateAll(r, {
      env: env(),
      sources: { gadget: sources.gadget },
      sourceCaps: { gadget: caps },
    });
    expect(got).toEqual([caps, { read: false, write: false, fields: {} }]);
  });
});

// -- compare ----------------------------------------------------------------------------------

describe('[LIF-060] compare harness', () => {
  const r = registry();
  const desired = baseWidget();

  it('[LIF-060] equal documents are equal regardless of array order', () => {
    const actual = baseWidget({
      tags: ['a', 'b'],
      rules: [
        { name: 'a', level: 2 },
        { name: 'z', level: 1 },
      ],
    });
    const c = compareFacet(r, 'widget', desired, actual);
    expect(c).toEqual({ facetKey: 'widget', status: 'equal', diffs: [], masked: [] });
  });

  it('[LIF-060] differences are keyed by path and sorted', () => {
    const actual = baseWidget({
      size: 4,
      rules: [
        { name: 'a', level: 9 },
        { name: 'q', level: 1 },
        { name: 'z', level: 1 },
      ],
    });
    const c = compareFacet(r, 'widget', desired, actual);
    expect(c?.status).toBe('different');
    expect(c?.diffs).toEqual([
      { path: '/rules[name=a]/level', desired: 2, actual: 9 },
      { path: '/rules[name=q]/level', desired: undefined, actual: 1 },
      { path: '/rules[name=q]/name', desired: undefined, actual: 'q' },
      { path: '/size', desired: 3, actual: 4 },
    ]);
  });

  it('[LIF-060] a target that could not be read is unverifiable; compareMode none writes no result', () => {
    expect(compareFacet(r, 'widget', desired, null)).toEqual({
      facetKey: 'widget',
      status: 'unverifiable',
      diffs: [],
      masked: [],
    });
    expect(compareFacet(r, 'notes', { text: 'a' }, { text: 'b' })).toBeNull();
  });

  it('[LIF-063] framework_mutation, identity_excluded and manual_accepted subtract matching diffs', () => {
    const actual = baseWidget({
      size: 4,
      rules: [
        { name: 'a', level: 2 },
        { name: 'sys-x', level: 1 },
        { name: 'z', level: 1 },
      ],
    });
    const c = compareFacet(r, 'widget', desired, actual, {
      expectedDifferences: [
        ed({ reason: 'framework_mutation', path: '/rules[name=sys-*]' }),
        ed({ reason: 'manual_accepted', path: '/size' }),
      ],
    });
    expect(c?.status).toBe('equal');
    expect(c?.masked.map((m) => [m.diff.path, m.reason, m.pattern])).toEqual([
      ['/rules[name=sys-x]/level', 'framework_mutation', '/rules[name=sys-*]'],
      ['/rules[name=sys-x]/name', 'framework_mutation', '/rules[name=sys-*]'],
      ['/size', 'manual_accepted', '/size'],
    ]);
    const excluded = compareFacet(r, 'widget', desired, baseWidget({ color: 'blue' }), {
      expectedDifferences: [ed({ reason: 'identity_excluded', path: '/color' })],
    });
    expect(excluded?.status).toBe('equal');
  });

  it('[LIF-063] lossy_accepted, unreadable_defaulted and overlay never hide a diff', () => {
    for (const reason of ['lossy_accepted', 'unreadable_defaulted', 'overlay'] as const) {
      const c = compareFacet(r, 'widget', desired, baseWidget({ size: 4 }), {
        expectedDifferences: [ed({ reason, path: '/size' })],
      });
      expect(c?.status, reason).toBe('different');
      expect(c?.masked).toEqual([]);
    }
  });

  it('[LIF-063] revoked records, other facets and non-matching or shorter patterns do not subtract', () => {
    const actual = baseWidget({ size: 4 });
    for (const e of [
      ed({ path: '/size', revokedAt: '2026-01-01' }),
      ed({ path: '/size', facetKey: 'gadget' }),
      ed({ path: '/color' }),
      ed({ path: '/size/deeper' }),
      ed({ path: '/rules[name=*]' }),
    ]) {
      expect(compareFacet(r, 'widget', desired, actual, { expectedDifferences: [e] })?.status).toBe(
        'different',
      );
    }
    // a pattern beneath-or-equal still works for an ancestor pattern
    expect(
      compareFacet(r, 'widget', desired, baseWidget({ rules: [] }), {
        expectedDifferences: [ed({ path: '/rules[name=*]/**', reason: 'manual_accepted' })],
      })?.status,
    ).toBe('equal');
  });

  it('[ADP-031] [LIF-060] invalid compare output is rejected', () => {
    const run = (diffs: unknown) =>
      compareFacet(
        new FacetRegistry().register({ ...widget, compare: () => diffs as FieldDiff[] }),
        'widget',
        desired,
        desired,
      );
    expect(() => run([{ path: 'bad', desired: 1, actual: 2 }])).toThrow(FacetEngineError);
    expect(() => run([null])).toThrow(FacetEngineError);
    expect(() => run('x')).toThrow(FacetEngineError);
    expect(() =>
      run([
        { path: '/a', desired: 1, actual: 2 },
        { path: '/a', desired: 1, actual: 3 },
      ]),
    ).toThrow(FacetEngineError);
    expect(() =>
      compareFacet(
        new FacetRegistry().register({
          ...widget,
          compare: () => {
            throw new Error('boom');
          },
        }),
        'widget',
        desired,
        desired,
      ),
    ).toThrow(FacetEngineError);
    // the root path is a legal diff location
    expect(run([{ path: '', desired: 1, actual: 2 }])?.status).toBe('different');
  });

  it('[ADP-031] compare cannot mutate its inputs and sees the context', () => {
    let ctxSeen: CompareContext | undefined;
    const reg = new FacetRegistry().register({
      ...widget,
      compare: (d, _a, ctx) => {
        ctxSeen = ctx;
        d.tags.push('x');
        return [];
      },
    });
    expect(() => compareFacet(reg, 'widget', desired, desired)).toThrow(FacetEngineError);
    expect(ctxSeen?.targetCaps).toEqual({ read: false, write: false, fields: {} });
    const ok = new FacetRegistry().register({
      ...widget,
      compare: (_d, _a, ctx) => {
        ctxSeen = ctx;
        return [];
      },
    });
    compareFacet(ok, 'widget', desired, desired, {
      ctx: { route: { a: 1 }, routeIndex: { b: 2 } },
    });
    expect(ctxSeen?.route).toEqual({ a: 1 });
    expect(ctxSeen?.routeIndex).toEqual({ b: 2 });
  });

  it('[LIF-060] an invalid actual document is an error, not a difference', () => {
    expect(() => compareFacet(r, 'widget', desired, { nope: 1 })).toThrow(/not valid/);
  });

  it('[LIF-061] satisfiedTasks returns only parity-completion tasks the facet reports satisfied', () => {
    const tasks = [
      { code: 'widget.supply-secret', params: {} },
      { code: 'widget.rule-unsupported', params: {} },
    ];
    const withSecret = baseWidget({ secret: { name: 's', readable: true } });
    expect(satisfiedTasks(r, 'widget', tasks, withSecret, []).map((t) => t.code)).toEqual([
      'widget.supply-secret',
    ]);
    expect(satisfiedTasks(r, 'widget', tasks, baseWidget(), [])).toEqual([]);
    expect(
      satisfiedTasks(r, 'gadget', tasks, { enabled: true, label: '', mode: 'fast' }, []),
    ).toEqual([]);
  });
});

describe('[ADP-021] diffDocuments', () => {
  const schema = { collections: [{ path: '/items', key: 'id' }], sets: ['/tags'] };
  it('[ADP-021] ignores order, treats empty collections as absent, distinguishes null from absent', () => {
    expect(
      diffDocuments(
        { items: [], tags: ['b', 'a'], n: null },
        { tags: ['a', 'b'], n: null },
        schema,
      ),
    ).toEqual([]);
    expect(diffDocuments({ n: null }, {}, schema)).toEqual([
      { path: '/n', desired: null, actual: undefined },
    ]);
    expect(diffDocuments({ tags: ['a'] }, { tags: ['a', 'b'] }, schema)).toEqual([
      { path: '/tags', desired: ['a'], actual: ['a', 'b'] },
    ]);
    expect(diffDocuments({ o: {} }, { o: { p: 1 } }, schema)).toEqual([
      { path: '/o/p', desired: undefined, actual: 1 },
    ]);
  });
});

describe('[FAC-005] review round 1 hardening', () => {
  const run = (
    patch: Partial<FacetDefinition<Widget>>,
    source: unknown = baseWidget(),
    e = env(),
  ) =>
    translateFacet(new FacetRegistry().register({ ...widget, ...patch }), 'widget', source, {
      env: e,
    });

  it('[FAC-005] a facet cannot self-accept by mutating ctx.policies, and the caller env is untouched', () => {
    const shared = env();
    const cheat: Partial<FacetDefinition<Widget>> = {
      translate(source, ctx) {
        try {
          (ctx.policies.acceptLossy as string[]).push('widget.teal-as-blue');
        } catch {
          // frozen: fine
        }
        return widget.translate(source, ctx);
      },
    };
    const t = run(cheat, baseWidget({ color: 'teal' }), shared);
    expect(t.decisions[0]?.accepted).toBe(false);
    expect(t.preTasks).toHaveLength(1);
    expect(shared.policies.acceptLossy).toEqual([]);
    // route, routeIndex and capabilities are frozen copies too
    const mut: Partial<FacetDefinition<Widget>> = {
      translate(source, ctx) {
        expect(() => {
          (ctx.route as Record<string, unknown>).x = 1;
        }).toThrow();
        expect(() => {
          (ctx.routeIndex as Record<string, unknown>).x = 1;
        }).toThrow();
        expect(Object.isFrozen(ctx.sourceCaps)).toBe(true);
        expect(Object.isFrozen(ctx.targetCaps)).toBe(true);
        return emptyResult(source);
      },
    };
    run(mut);
  });

  it('[LIF-006] [FAC-005] a new lossy path under an accepted key opens a new task (sequence across two analyses)', () => {
    const reg = new FacetRegistry().register({
      ...widget,
      translate: (s) => ({
        ...emptyResult(s),
        decisions: [
          { path: '/color', fidelity: 'lossy', policyKey: 'widget.teal-as-blue', accepted: false },
          ...(s.size > 5
            ? [
                {
                  path: '/size',
                  fidelity: 'lossy' as const,
                  policyKey: 'widget.teal-as-blue',
                  accepted: false as const,
                },
              ]
            : []),
        ],
      }),
    });
    const first = translateFacet(reg, 'widget', baseWidget(), { env: env(), migrationId: 'm1' });
    const task1 = first.preTasks[0];
    expect(task1?.paths).toEqual(['/color']);
    // the operator marks it done: a migration-scoped record covering exactly its paths
    const record = ed({
      reason: 'lossy_accepted',
      migrationId: 'm1',
      note: 'widget.teal-as-blue',
      path: '/color',
    });
    const second = translateFacet(reg, 'widget', baseWidget({ size: 9 }), {
      env: env(),
      migrationId: 'm1',
      expectedDifferences: [record],
    });
    expect(second.decisions.map((d) => [d.path, d.accepted])).toEqual([
      ['/color', 'migration'],
      ['/size', false],
    ]);
    const task2 = second.preTasks[0];
    expect(task2?.paths).toEqual(['/size']);
    expect(hashCanonical(task2?.params)).not.toBe(hashCanonical(task1?.params));
    const third = translateFacet(reg, 'widget', baseWidget({ size: 9 }), {
      env: env(),
      migrationId: 'm1',
      expectedDifferences: [record, { ...record, path: '/size' }],
    });
    expect(third.preTasks).toEqual([]);
  });

  it('[LIF-063] only records of the Route or of this Migration apply (translate and compare)', () => {
    const accept = ed({
      reason: 'lossy_accepted',
      migrationId: 'm1',
      note: 'widget.teal-as-blue',
      path: '/color',
    });
    const teal = baseWidget({ color: 'teal' });
    const accepted = (migrationId: string | undefined) =>
      T(registry(), 'widget', teal, {
        env: env(),
        migrationId,
        expectedDifferences: [accept],
      } as never).decisions[0]?.accepted;
    expect(accepted('m1')).toBe('migration');
    expect(accepted('m2')).toBe(false);
    expect(accepted(undefined)).toBe(false);

    const masking = ed({ reason: 'manual_accepted', path: '/size', migrationId: 'm1' });
    const diff = (migrationId: string | undefined) =>
      compareFacet(registry(), 'widget', baseWidget(), baseWidget({ size: 4 }), {
        migrationId,
        expectedDifferences: [masking],
      })?.status;
    expect(diff('m1')).toBe('equal');
    expect(diff('m2')).toBe('different');
    expect(diff(undefined)).toBe('different');
    const routeWide = { ...masking, migrationId: null };
    expect(
      compareFacet(registry(), 'widget', baseWidget(), baseWidget({ size: 4 }), {
        migrationId: 'zz',
        expectedDifferences: [routeWide],
      })?.status,
    ).toBe('equal');
  });

  it('[LIF-063] framework_mutation masks target extras only, not changes to desired values', () => {
    const fm = ed({ reason: 'framework_mutation', path: '/rules[name=sys-*]' });
    const extra = baseWidget({
      rules: [
        { name: 'a', level: 2 },
        { name: 'sys-x', level: 1 },
        { name: 'z', level: 1 },
      ],
    });
    expect(
      compareFacet(registry(), 'widget', baseWidget(), extra, { expectedDifferences: [fm] })
        ?.status,
    ).toBe('equal');
    const desiredHasIt = baseWidget({
      rules: [
        { name: 'a', level: 2 },
        { name: 'sys-x', level: 5 },
        { name: 'z', level: 1 },
      ],
    });
    const c = compareFacet(registry(), 'widget', desiredHasIt, extra, {
      expectedDifferences: [fm],
    });
    expect(c?.status).toBe('different');
    expect(c?.diffs.map((d) => d.path)).toEqual(['/rules[name=sys-x]/level']);
    // the target dropped a desired element: also not masked
    const dropped = compareFacet(registry(), 'widget', desiredHasIt, baseWidget(), {
      expectedDifferences: [fm],
    });
    expect(dropped?.status).toBe('different');
  });

  it('[ADP-040] unsupported and non-defaulted unreadable decisions need a covering finding', () => {
    const dec = (path: string, fidelity: 'unsupported' | 'unreadable', defaulted?: boolean) => ({
      translate: (s: Widget) => ({
        ...emptyResult(s),
        decisions: [
          { path, fidelity, accepted: false as const, ...(defaulted ? { defaulted } : {}) },
        ],
      }),
    });
    const err = (patch: Partial<FacetDefinition<Widget>>) => {
      try {
        run(patch);
      } catch (e) {
        return (e as FacetEngineError).code;
      }
      return 'ok';
    };
    expect(err(dec('/rules[name=a]', 'unsupported'))).toBe('uncovered_decision');
    expect(err(dec('/secret', 'unreadable'))).toBe('uncovered_decision');
    expect(err(dec('/secret', 'unreadable', true))).toBe('ok');
    const withFinding = (path: string, findingPath: string) => ({
      translate: (s: Widget) => ({
        ...emptyResult(s),
        decisions: [{ path, fidelity: 'unsupported' as const, accepted: false as const }],
        postTasks: [{ code: 'widget.rule-unsupported', paths: [findingPath], params: {} }],
      }),
    });
    expect(err(withFinding('/rules[name=a]', '/rules[name=a]'))).toBe('ok');
    expect(err(withFinding('/rules[name=a]/level', '/rules[name=a]'))).toBe('ok');
    expect(err(withFinding('/rules[name=a]', '/rules[name=a]/level'))).toBe('ok');
    expect(err(withFinding('/rules[name=a]', ''))).toBe('ok');
    expect(err(withFinding('/rules[name=a]', '/rules[name=b]'))).toBe('uncovered_decision');
    expect(err(withFinding('/rules[name=a]', '/size'))).toBe('uncovered_decision');
  });

  it('[LIF-063] masking credit does not depend on record order; ids are returned', () => {
    const a = ed({ id: 'e1', reason: 'manual_accepted', path: '/size' });
    const b = ed({ id: 'e2', reason: 'identity_excluded', path: '/size' });
    const c = ed({ id: 'e0', reason: 'identity_excluded', path: '/size' });
    const run1 = (list: ExpectedDifferenceRecord[]) =>
      compareFacet(registry(), 'widget', baseWidget(), baseWidget({ size: 4 }), {
        expectedDifferences: list,
      })?.masked;
    const forward = run1([a, b, c]);
    expect(run1([c, b, a])).toEqual(forward);
    expect(run1([b, a, c])).toEqual(forward);
    expect(forward?.[0]).toMatchObject({ reason: 'identity_excluded', expectedDifferenceId: 'e0' });
  });

  it('[LIF-063] scales: 10k keyed elements against 200 records stays within budget', () => {
    const rules = (n: number, level: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `r${String(i).padStart(5, '0')}`, level }));
    const records = Array.from({ length: 200 }, (_, i) =>
      ed({
        id: `e${i}`,
        reason: 'manual_accepted',
        path: `/rules[name=r${String(i).padStart(5, '0')}]/level`,
      }),
    );
    const started = Date.now();
    const c = compareFacet(
      registry(),
      'widget',
      baseWidget({ rules: rules(10_000, 1) }),
      baseWidget({ rules: rules(10_000, 2) }),
      { expectedDifferences: records },
    );
    expect(c?.diffs.length).toBeGreaterThan(0);
    expect(c?.masked.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
