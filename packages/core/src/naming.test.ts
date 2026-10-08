import { describe, expect, it } from 'vitest';
import {
  classifyExistingTarget,
  collisionKey,
  detectCollisions,
  kebab,
  type NamingLimits,
  type NamingPipeline,
  type NamingSource,
  type NamingStep,
  planRouteNaming,
  resolveTargetName,
  runNamingPipeline,
  selectNamingRule,
  validateReplacePattern,
  validateTargetName,
} from './naming.ts';

const limits: NamingLimits = {
  maxLength: 100,
  pattern: /^[A-Za-z0-9._-]+$/,
  caseInsensitiveUnique: true,
};

const defaultPipeline: NamingPipeline = {
  steps: [
    { var: 'namespace', op: 'projectKey' },
    { var: 'namespace', op: 'lowercase' },
    { var: 'repository', op: 'slug' },
    { var: 'repository', op: 'kebab' },
  ],
  template: '{namespace}-{repository}',
};

const src = (key: string, slug: string): NamingSource => ({
  namespace: { key, slug: key.toLowerCase(), name: `Project ${key}` },
  repository: { slug, name: slug },
});

function failure(p: NamingPipeline, s: NamingSource): string {
  const r = runNamingPipeline(p, s);
  if (r.ok) throw new Error('expected failure');
  expect(r.issue.reason).toBe('pipeline');
  return r.issue.message;
}

describe('[LIF-030] pipeline operations', () => {
  it('[LIF-030] the default pipeline yields {lowercased key}-{kebab slug}', () => {
    expect(runNamingPipeline(defaultPipeline, src('PROJ', 'My_Repo.Name'))).toEqual({
      ok: true,
      value: 'proj-my-repo-name',
    });
  });

  it('[LIF-030] projectKey, slug and name initialize from the matching source field', () => {
    const s: NamingSource = {
      namespace: { key: 'K', slug: 'ns-slug', name: 'NS Name' },
      repository: { slug: 'r-slug', name: 'R Name' },
      group: { slug: 'g-slug', name: 'G Name' },
    };
    const run = (v: 'namespace' | 'repository' | 'group', op: 'projectKey' | 'slug' | 'name') =>
      runNamingPipeline({ steps: [{ var: v, op }], template: `{${v}}` }, s);
    expect(run('namespace', 'projectKey')).toEqual({ ok: true, value: 'K' });
    expect(run('namespace', 'slug')).toEqual({ ok: true, value: 'ns-slug' });
    expect(run('namespace', 'name')).toEqual({ ok: true, value: 'NS Name' });
    expect(run('repository', 'slug')).toEqual({ ok: true, value: 'r-slug' });
    expect(run('repository', 'name')).toEqual({ ok: true, value: 'R Name' });
    expect(run('group', 'slug')).toEqual({ ok: true, value: 'g-slug' });
    expect(run('group', 'name')).toEqual({ ok: true, value: 'G Name' });
  });

  it('[LIF-030] team slugs use a pipeline over the variable group', () => {
    const team: NamingPipeline = {
      steps: [
        { var: 'group', op: 'slug' },
        { var: 'group', op: 'kebab' },
      ],
      template: '{group}',
    };
    expect(runNamingPipeline(team, { group: { slug: 'Core Team_1', name: 'x' } })).toEqual({
      ok: true,
      value: 'core-team-1',
    });
  });

  it('[LIF-030] lowercase lowercases', () => {
    const p: NamingPipeline = {
      steps: [
        { var: 'repository', op: 'name' },
        { var: 'repository', op: 'lowercase' },
      ],
      template: '{repository}',
    };
    expect(runNamingPipeline(p, { repository: { slug: 's', name: 'MiXeD' } })).toEqual({
      ok: true,
      value: 'mixed',
    });
  });

  it('[LIF-030] kebab lowercases, collapses runs outside [a-z0-9] and trims dashes', () => {
    expect(kebab('  --Hello,   World__Foo!! ')).toBe('hello-world-foo');
    expect(kebab('a')).toBe('a');
    expect(kebab('---')).toBe('');
    expect(kebab('')).toBe('');
    expect(kebab('Ünï-cödé')).toBe('n-c-d');
    expect(kebab('a1-b2')).toBe('a1-b2');
  });

  it('[LIF-030] truncate keeps the first arg code points', () => {
    const t = (arg: number | undefined, v = 'abcdef😀gh') =>
      runNamingPipeline(
        {
          steps: [
            { var: 'repository', op: 'name' },
            { var: 'repository', op: 'truncate', arg },
          ],
          template: '{repository}',
        },
        { repository: { slug: 's', name: v } },
      );
    expect(t(3)).toEqual({ ok: true, value: 'abc' });
    expect(t(7)).toEqual({ ok: true, value: 'abcdef😀' });
    expect(t(100)).toEqual({ ok: true, value: 'abcdef😀gh' });
  });

  it('[LIF-030] truncate without a positive integer arg is a pipeline error', () => {
    const mk = (arg?: number): NamingPipeline => ({
      steps: [
        { var: 'repository', op: 'slug' },
        { var: 'repository', op: 'truncate', arg },
      ],
      template: '{repository}',
    });
    for (const arg of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(failure(mk(arg), src('K', 'abc'))).toMatch(/truncate needs/);
    }
  });

  it('[LIF-030] replace applies a global unicode regex, with $n captures', () => {
    const p = (pattern: string, w: string): NamingPipeline => ({
      steps: [
        { var: 'repository', op: 'slug' },
        { var: 'repository', op: 'replace', pattern, with: w },
      ],
      template: '{repository}',
    });
    expect(runNamingPipeline(p('^legacy-', ''), src('K', 'legacy-app'))).toEqual({
      ok: true,
      value: 'app',
    });
    expect(runNamingPipeline(p('a', 'X'), src('K', 'banana'))).toEqual({
      ok: true,
      value: 'bXnXnX',
    });
    expect(runNamingPipeline(p('(\\w+)-(\\w+)', '$2-$1'), src('K', 'ab-cd'))).toEqual({
      ok: true,
      value: 'cd-ab',
    });
  });

  it('[LIF-030] an invalid replace pattern is a pipeline error, not an exception', () => {
    const msg = failure(
      {
        steps: [
          { var: 'repository', op: 'slug' },
          { var: 'repository', op: 'replace', pattern: '(', with: '' },
        ],
        template: '{repository}',
      },
      src('K', 'a'),
    );
    expect(msg).toMatch(/not valid RE2 syntax/);
  });

  it('[LIF-030] steps apply in order and variables are independent', () => {
    const p: NamingPipeline = {
      steps: [
        { var: 'namespace', op: 'name' },
        { var: 'repository', op: 'slug' },
        { var: 'namespace', op: 'kebab' },
        { var: 'repository', op: 'lowercase' },
      ],
      template: '{repository}.{namespace}.{repository}',
    };
    expect(runNamingPipeline(p, src('K', 'ABC'))).toEqual({ ok: true, value: 'abc.project-k.abc' });
  });

  it('[LIF-030] pipeline faults are reported as issues', () => {
    expect(
      failure(
        { steps: [{ var: 'repository', op: 'lowercase' }], template: '{repository}' },
        src('K', 'a'),
      ),
    ).toMatch(/before it is initialized/);
    expect(
      failure({ steps: [{ var: 'repository', op: 'slug' }], template: '{nope}' }, src('K', 'a')),
    ).toMatch(/\{nope\}/);
    expect(
      failure({ steps: [{ var: 'repository', op: 'slug' }], template: '{repository}' }, {}),
    ).toMatch(/no repository/);
    expect(
      failure(
        { steps: [{ var: 'repository', op: 'projectKey' }], template: '{repository}' },
        src('K', 'a'),
      ),
    ).toMatch(/has no key/);
    expect(
      failure(
        { steps: [{ var: 'namespace', op: 'projectKey' }], template: '{namespace}' },
        { namespace: { key: null, slug: 's', name: 'n' } },
      ),
    ).toMatch(/has no key/);
    expect(
      failure(
        { steps: [{ var: 'namespace', op: 'name' }], template: '{namespace}' },
        { namespace: { slug: 's', name: '' } },
      ),
    ).toMatch(/has no name/);
    expect(
      failure(
        { steps: [{ var: 'custom', op: 'slug' } as NamingStep], template: '' },
        src('K', 'a'),
      ),
    ).toMatch(/can only initialize/);
    expect(
      failure(
        {
          steps: [
            { var: 'repository', op: 'slug' },
            { var: 'repository', op: 'bogus' } as unknown as NamingStep,
          ],
          template: '',
        },
        src('K', 'a'),
      ),
    ).toMatch(/unknown op/);
  });

  it('[LIF-030] a template with no variables is a literal', () => {
    expect(runNamingPipeline({ steps: [], template: 'fixed' }, {})).toEqual({
      ok: true,
      value: 'fixed',
    });
  });
});

describe('[LIF-030] rule precedence', () => {
  const repoP: NamingPipeline = { steps: [], template: 'from-repo' };
  const nsP: NamingPipeline = { steps: [], template: 'from-ns' };
  const base = { routeDefault: defaultPipeline };

  it('[LIF-030] override beats repository pipeline beats namespace pipeline beats Route default', () => {
    const all = { ...base, override: 'literal', repositoryPipeline: repoP, namespacePipeline: nsP };
    expect(selectNamingRule(all)).toEqual({ source: 'override', override: 'literal' });
    expect(selectNamingRule({ ...all, override: null })).toEqual({
      source: 'repository',
      pipeline: repoP,
    });
    expect(selectNamingRule({ ...all, override: '', repositoryPipeline: undefined })).toEqual({
      source: 'namespace',
      pipeline: nsP,
    });
    expect(selectNamingRule({ ...base, namespacePipeline: null })).toEqual({
      source: 'default',
      pipeline: defaultPipeline,
    });
  });

  it('[LIF-030] resolveTargetName uses the winning rule and reports which one', () => {
    const s = src('PROJ', 'repo');
    expect(resolveTargetName({ ...base, override: 'Exact_Name' }, s, limits)).toEqual({
      ok: true,
      name: 'Exact_Name',
      ruleSource: 'override',
    });
    expect(
      resolveTargetName({ ...base, repositoryPipeline: repoP, namespacePipeline: nsP }, s, limits),
    ).toEqual({ ok: true, name: 'from-repo', ruleSource: 'repository' });
    expect(resolveTargetName({ ...base, namespacePipeline: nsP }, s, limits)).toEqual({
      ok: true,
      name: 'from-ns',
      ruleSource: 'namespace',
    });
    expect(resolveTargetName(base, s, limits)).toEqual({
      ok: true,
      name: 'proj-repo',
      ruleSource: 'default',
    });
  });

  it('[LIF-030] an override is validated like any other name', () => {
    const r = resolveTargetName({ ...base, override: 'bad name!' }, src('K', 'a'), limits);
    expect(r.ok).toBe(false);
    expect(r.ruleSource).toBe('override');
  });

  it('[LIF-030] a pipeline fault surfaces as naming.invalid with the rule that failed', () => {
    const r = resolveTargetName(
      { ...base, namespacePipeline: { steps: [{ var: 'x', op: 'lowercase' }], template: '' } },
      src('K', 'a'),
      limits,
    );
    expect(r).toMatchObject({
      ok: false,
      ruleSource: 'namespace',
      issues: [{ code: 'naming.invalid', reason: 'pipeline' }],
    });
  });
});

describe('[LIF-031] validation against target limits', () => {
  const reasons = (name: string, l: NamingLimits = limits) => {
    const r = validateTargetName(name, l);
    return r.ok ? [] : r.issues.map((i) => i.reason);
  };

  it('[LIF-031] accepts valid names, including exactly maxLength', () => {
    expect(validateTargetName('ok.name_1-x', limits)).toEqual({ ok: true, name: 'ok.name_1-x' });
    expect(validateTargetName('a'.repeat(100), limits).ok).toBe(true);
  });

  it('[LIF-031] rejects empty names', () => {
    expect(reasons('')).toEqual(['empty']);
  });

  it('[LIF-031] rejects names over maxLength, naming the numbers', () => {
    const r = validateTargetName('a'.repeat(101), limits);
    expect(r).toMatchObject({
      ok: false,
      issues: [
        { code: 'naming.invalid', reason: 'too-long', params: { length: 101, maxLength: 100 } },
      ],
    });
  });

  it('[LIF-031] rejects disallowed characters and lists them', () => {
    const r = validateTargetName('a b/c', limits);
    expect(r).toMatchObject({
      ok: false,
      issues: [{ reason: 'invalid-characters', params: { characters: ' /' } }],
    });
  });

  it('[LIF-031] counts length in code points', () => {
    const wide: NamingLimits = { ...limits, maxLength: 3, pattern: /^.+$/u };
    expect(validateTargetName('😀😀😀', wide).ok).toBe(true);
    expect(reasons('😀😀😀😀', wide)).toEqual(['too-long']);
  });

  it('[LIF-031] rejects . and .. and configured reserved names, case-insensitively', () => {
    expect(reasons('.')).toEqual(['reserved-name']);
    expect(reasons('..')).toEqual(['reserved-name']);
    const l: NamingLimits = { ...limits, reservedNames: ['Settings'] };
    expect(reasons('SETTINGS', l)).toEqual(['reserved-name']);
    expect(reasons('settings2', l)).toEqual([]);
  });

  it('[LIF-031] rejects reserved suffixes', () => {
    const l: NamingLimits = { ...limits, reservedSuffixes: ['.git', ''] };
    expect(reasons('repo.GIT', l)).toEqual(['reserved-suffix']);
    expect(reasons('repo', l)).toEqual([]);
  });

  it('[LIF-031] reports every violated rule at once', () => {
    expect(reasons('b a d'.repeat(30))).toEqual(['too-long', 'invalid-characters']);
  });

  it('[LIF-031] global/sticky patterns do not make validation stateful', () => {
    const g: NamingLimits = { ...limits, pattern: /^[a-z]+$/g };
    expect(validateTargetName('abc', g).ok).toBe(true);
    expect(validateTargetName('abc', g).ok).toBe(true);
    const y: NamingLimits = { ...limits, pattern: /^[a-z]+$/y };
    expect(validateTargetName('abc', y).ok).toBe(true);
  });
});

describe('[LIF-031] collisions', () => {
  it('[LIF-031] detects case-insensitive collisions and reports every group and member', () => {
    const groups = detectCollisions([
      { id: '1', name: 'Alpha' },
      { id: '2', name: 'beta' },
      { id: '3', name: 'ALPHA' },
      { id: '4', name: 'BETA' },
      { id: '5', name: 'alpha' },
      { id: '6', name: 'gamma' },
    ]);
    expect(groups).toEqual([
      {
        key: 'alpha',
        members: [
          { id: '1', name: 'Alpha' },
          { id: '3', name: 'ALPHA' },
          { id: '5', name: 'alpha' },
        ],
      },
      {
        key: 'beta',
        members: [
          { id: '2', name: 'beta' },
          { id: '4', name: 'BETA' },
        ],
      },
    ]);
  });

  it('[LIF-031] no collisions when names differ, and none for one claim', () => {
    expect(detectCollisions([])).toEqual([]);
    expect(
      detectCollisions([
        { id: '1', name: 'a' },
        { id: '2', name: 'b' },
      ]),
    ).toEqual([]);
  });

  it('[LIF-031] is Unicode-normalization aware (NFC/NFD and compatibility forms)', () => {
    expect(collisionKey('é')).toBe(collisionKey('é'));
    expect(collisionKey('Ａbc')).toBe('abc');
    expect(
      detectCollisions([
        { id: '1', name: 'café' },
        { id: '2', name: 'café' },
      ]),
    ).toHaveLength(1);
  });

  it('[LIF-031] case-sensitive targets only collide on exact (normalized) equality', () => {
    expect(
      detectCollisions(
        [
          { id: '1', name: 'A' },
          { id: '2', name: 'a' },
        ],
        false,
      ),
    ).toEqual([]);
    expect(
      detectCollisions(
        [
          { id: '1', name: 'A' },
          { id: '2', name: 'A' },
        ],
        false,
      ),
    ).toHaveLength(1);
  });

  it('[LIF-031] property: collision groups equal a brute-force pairwise check', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const alphabet = ['a', 'A', 'b', 'B', '-', 'é', 'é'];
    for (let round = 0; round < 200; round++) {
      const claims = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => ({
        id: String(i),
        name: Array.from(
          { length: 1 + Math.floor(rnd() * 2) },
          () => alphabet[Math.floor(rnd() * alphabet.length)],
        ).join(''),
      }));
      const grouped = new Set(detectCollisions(claims).flatMap((g) => g.members.map((m) => m.id)));
      const brute = new Set<string>();
      for (const a of claims) {
        for (const b of claims) {
          if (
            a.id !== b.id &&
            a.name.normalize('NFKC').toLowerCase() === b.name.normalize('NFKC').toLowerCase()
          )
            brute.add(a.id);
        }
      }
      expect(grouped).toEqual(brute);
    }
  });

  it('[LIF-030] property: kebab is idempotent and always matches [a-z0-9-] without edge dashes', () => {
    let seed = 99;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 500; i++) {
      const s = Array.from({ length: Math.floor(rnd() * 20) }, () =>
        String.fromCodePoint(32 + Math.floor(rnd() * 400)),
      ).join('');
      const k = kebab(s);
      expect(kebab(k)).toBe(k);
      expect(k).toMatch(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/);
    }
  });
});

describe('[LIF-031] existing target repositories', () => {
  const existing = [
    { id: 't1', name: 'Taken-Full', hasRefs: true },
    { id: 't2', name: 'taken-empty', hasRefs: false },
  ];

  it('[LIF-031] no match is none', () => {
    expect(classifyExistingTarget({ plannedName: 'free', existing })).toEqual({ kind: 'none' });
  });

  it('[LIF-031] a non-empty existing target not owned by the Migration is exists-nonempty (case-insensitive)', () => {
    expect(classifyExistingTarget({ plannedName: 'taken-full', existing })).toEqual({
      kind: 'exists-nonempty',
      target: existing[0],
    });
  });

  it('[LIF-031] an existing empty target is adopted: exists-foreign-adopted (information)', () => {
    expect(classifyExistingTarget({ plannedName: 'TAKEN-EMPTY', existing })).toEqual({
      kind: 'exists-foreign-adopted',
      target: existing[1],
    });
  });

  it('[LIF-031] a target whose id equals targetRepositoryId is owned, whatever its name or refs', () => {
    expect(
      classifyExistingTarget({ plannedName: 'renamed', targetRepositoryId: 't1', existing }),
    ).toEqual({ kind: 'owned', target: existing[0] });
    expect(
      classifyExistingTarget({ plannedName: 'taken-full', targetRepositoryId: 't1', existing })
        .kind,
    ).toBe('owned');
  });

  it('[LIF-031] a targetRepositoryId that no longer exists falls back to lookup by name', () => {
    expect(
      classifyExistingTarget({ plannedName: 'taken-full', targetRepositoryId: 'gone', existing })
        .kind,
    ).toBe('exists-nonempty');
  });

  it('[LIF-031] case-sensitive targets match by exact name only', () => {
    expect(
      classifyExistingTarget({ plannedName: 'taken-full', existing, caseInsensitive: false }),
    ).toEqual({ kind: 'none' });
  });
});

describe('[LIF-030] [LIF-031] planRouteNaming', () => {
  const m = (
    id: string,
    key: string,
    slug: string,
    extra: Partial<Parameters<typeof planRouteNaming>[0][number]> = {},
  ) => ({
    id,
    source: src(key, slug),
    rules: { routeDefault: defaultPipeline },
    ...extra,
  });

  it('[LIF-031] blocks every member of every collision group and names the others', () => {
    const plan = planRouteNaming(
      [
        m('a', 'P', 'Repo'),
        m('b', 'p', 'repo'),
        m('c', 'Q', 'x'),
        m('d', 'Q', 'X'),
        m('e', 'R', 'solo'),
      ],
      limits,
    );
    expect(plan.collisions.map((g) => g.members.map((x) => x.id))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    const byId = Object.fromEntries(plan.entries.map((e) => [e.id, e]));
    expect(byId.a?.findings).toEqual([
      { code: 'naming.collision', severity: 'blocker', params: { name: 'p-repo', with: ['b'] } },
    ]);
    expect(byId.b?.blocked && byId.c?.blocked && byId.d?.blocked).toBe(true);
    expect(byId.e).toMatchObject({ plannedName: 'r-solo', blocked: false, findings: [] });
  });

  it('[LIF-031] invalid names raise naming.invalid and do not join collisions', () => {
    const plan = planRouteNaming(
      [
        m('a', 'P', 'x', { rules: { routeDefault: defaultPipeline, override: 'bad name' } }),
        m('b', 'P', 'y', { rules: { routeDefault: defaultPipeline, override: 'bad name' } }),
      ],
      limits,
    );
    expect(plan.collisions).toEqual([]);
    expect(plan.entries.every((e) => e.blocked && e.plannedName === null)).toBe(true);
    expect(plan.entries[0]?.findings[0]).toMatchObject({
      code: 'naming.invalid',
      severity: 'blocker',
      params: { reason: 'invalid-characters' },
    });
  });

  it('[LIF-031] classifies existing targets: non-empty blocks, empty is information, owned is silent', () => {
    const existing = [
      { id: 't1', name: 'p-full', hasRefs: true },
      { id: 't2', name: 'p-empty', hasRefs: false },
      { id: 't3', name: 'p-mine', hasRefs: true },
    ];
    const plan = planRouteNaming(
      [
        m('a', 'P', 'full'),
        m('b', 'P', 'empty'),
        m('c', 'P', 'mine', { targetRepositoryId: 't3' }),
        m('d', 'P', 'new'),
      ],
      limits,
      existing,
    );
    const byId = Object.fromEntries(plan.entries.map((e) => [e.id, e]));
    expect(byId.a?.findings.map((f) => [f.code, f.severity])).toEqual([
      ['target.exists-nonempty', 'blocker'],
    ]);
    expect(byId.a?.blocked).toBe(true);
    expect(byId.b?.findings.map((f) => [f.code, f.severity])).toEqual([
      ['target.exists-foreign-adopted', 'info'],
    ]);
    expect(byId.b?.blocked).toBe(false);
    expect(byId.c?.findings).toEqual([]);
    expect(byId.d?.findings).toEqual([]);
  });

  it('[LIF-031] a collision and an existing target can both be reported for one Migration', () => {
    const plan = planRouteNaming([m('a', 'P', 'x'), m('b', 'P', 'X')], limits, [
      { id: 't', name: 'P-X', hasRefs: true },
    ]);
    expect(plan.entries[0]?.findings.map((f) => f.code)).toEqual([
      'naming.collision',
      'target.exists-nonempty',
    ]);
  });

  it('[LIF-031] uniqueness follows the target limit caseInsensitiveUnique', () => {
    const cs: NamingLimits = { ...limits, caseInsensitiveUnique: false };
    const plan = planRouteNaming(
      [
        m('a', 'P', 'x', { rules: { routeDefault: defaultPipeline, override: 'Abc' } }),
        m('b', 'P', 'y', { rules: { routeDefault: defaultPipeline, override: 'abc' } }),
      ],
      cs,
    );
    expect(plan.collisions).toEqual([]);
  });
});

describe('[LIF-030] replace safety (ADR-0095)', () => {
  const rp = (pattern: string, w = ''): NamingPipeline => ({
    steps: [
      { var: 'repository', op: 'slug' },
      { var: 'repository', op: 'replace', pattern, with: w },
    ],
    template: '{repository}',
  });

  it('[LIF-030] rejects back references, lookarounds, invalid syntax and the empty pattern', () => {
    for (const bad of [
      '(a)\\1',
      '(?<x>a)\\k<x>',
      '(?=a)',
      '(?!a)',
      '(?<=a)b',
      '(',
      'a)',
      '[',
      '*a',
      '',
    ]) {
      expect(validateReplacePattern(bad), bad).not.toBeNull();
    }
    expect(runNamingPipeline(rp('(?=a)'), src('K', 'a'))).toMatchObject({
      ok: false,
      issue: { params: { cause: 'unsafe-pattern' } },
    });
  });

  it('[LIF-030] accepts ordinary patterns, including ones nested quantifiers (safe under RE2)', () => {
    for (const ok of [
      '^legacy-',
      '[a-z]+\\d{2,3}',
      '(foo|bar)-',
      '(ab)+',
      'x+?y',
      '\\p{L}+',
      '(a+)+$',
      '(?i)a',
    ]) {
      expect(validateReplacePattern(ok), ok).toBeNull();
    }
  });

  it('[LIF-030] rejects replacement references that do not resolve against the pattern', () => {
    expect(validateReplacePattern('a', '$5')).toMatch(/group 5 but the pattern has 0/);
    expect(validateReplacePattern('(a)(b)', '$3')).toMatch(/group 3 but the pattern has 2/);
    expect(validateReplacePattern('(a)', '$2')).toMatch(/group 2 but the pattern has 1/);
    expect(validateReplacePattern('(a)', '$10')).toMatch(/group 10 but the pattern has 1/);
    expect(validateReplacePattern('(a)', '$0')).not.toBeNull();
    expect(validateReplacePattern('(a)', '$<y>')).toMatch(/unknown group "y"/);
    expect(validateReplacePattern('(?P<z>a)', '$<y>')).not.toBeNull();
    expect(runNamingPipeline(rp('a', '$5'), src('K', 'a'))).toMatchObject({
      ok: false,
      issue: { params: { cause: 'unsafe-pattern' } },
    });
  });

  it('[LIF-030] accepts resolving references, $$, and literal braces, $& and a lone $', () => {
    expect(validateReplacePattern('(a)(?P<y>b)', '$1-$2-$<y>-$$')).toBeNull();
    expect(validateReplacePattern('a', '$\u007b1}$&$')).toBeNull();
    expect(runNamingPipeline(rp('a', 'x$$'), src('K', 'a'))).toEqual({ ok: true, value: 'x$' });
  });

  it('[LIF-030] rejects oversized pattern or replacement', () => {
    expect(validateReplacePattern('a'.repeat(201))).toMatch(/pattern is longer/);
    expect(validateReplacePattern('a', 'b'.repeat(201))).toMatch(/replacement is longer/);
  });

  it('[LIF-030] replacement uses RE2 syntax: $1 and $<name>', () => {
    expect(runNamingPipeline(rp('(?P<l>[a-z]+)-(\\d+)', '$2-$<l>'), src('K', 'ab-12'))).toEqual({
      ok: true,
      value: '12-ab',
    });
  });

  it('[LIF-030] every adversarial pattern finishes in under 250 ms on 256 characters', () => {
    const cases: [string, string][] = [
      ['a*a*a*a*a*a*a*a*b', 'a'.repeat(256)],
      ['.*.*.*.*.*.*b', 'a'.repeat(256)],
      ['[a-z]*[a-z]*[a-z]*[a-z]*!', 'a'.repeat(255)],
      ['\\p{L}*\\p{L}*\\p{L}*x', 'é'.repeat(256)],
      [`${'a?'.repeat(60)}${'a'.repeat(60)}b`, 'a'.repeat(60)],
      [`${'(a?)'.repeat(36)}${'a'.repeat(36)}b`, 'a'.repeat(36)],
      [`${'(a|a)'.repeat(36)}b`, 'a'.repeat(36)],
      ['(a+)+$', `${'a'.repeat(255)}!`],
      ['(a|aa)+$', `${'a'.repeat(255)}!`],
      ['(.*a){10}', 'a'.repeat(256)],
    ];
    for (const [pattern, input] of cases) {
      const t0 = performance.now();
      const r = runNamingPipeline(rp(pattern, 'x'), src('K', input));
      expect(performance.now() - t0, pattern).toBeLessThan(250);
      expect(r.ok || r.issue.reason === 'pipeline', pattern).toBe(true);
    }
  });

  it('[LIF-030] a replace chain cannot grow a value past the cap', () => {
    const grow: NamingStep = {
      var: 'repository',
      op: 'replace',
      pattern: '.',
      with: 'x'.repeat(200),
    };
    const p: NamingPipeline = {
      steps: [{ var: 'repository', op: 'slug' }, grow, grow, grow, grow, grow],
      template: '{repository}',
    };
    expect(runNamingPipeline(p, src('K', 'a'.repeat(256)))).toMatchObject({
      ok: false,
      issue: { params: { cause: 'input-too-long', max: 256 } },
    });
  });

  it('[LIF-030] runNamingPipeline never throws: unexpected faults become an internal issue', () => {
    const bad = {
      steps: [
        { var: 'repository', op: 'slug' },
        { var: 'repository', op: 'replace', pattern: 5, with: 1 },
      ],
      template: '{repository}',
    } as unknown as NamingPipeline;
    expect(runNamingPipeline(bad, src('K', 'a'))).toMatchObject({
      ok: false,
      issue: { reason: 'pipeline' },
    });
    const worse = { steps: null, template: '' } as unknown as NamingPipeline;
    expect(runNamingPipeline(worse, src('K', 'a'))).toMatchObject({
      ok: false,
      issue: { params: { cause: 'internal' } },
    });
    const nonError = {
      get steps(): never {
        throw 'boom';
      },
      template: '',
    } as unknown as NamingPipeline;
    expect(runNamingPipeline(nonError, src('K', 'a'))).toMatchObject({
      ok: false,
      issue: { params: { cause: 'internal' } },
    });
  });

  it('[LIF-030] the ReDoS probe (a+)+$ runs in linear time on the RE2 engine', () => {
    const t0 = performance.now();
    const r = runNamingPipeline(rp('(a+)+$', 'b'), src('K', `${'a'.repeat(200)}!`));
    expect(performance.now() - t0).toBeLessThan(250);
    expect(r).toEqual({ ok: true, value: `${'a'.repeat(200)}!` });
  });

  it('[LIF-030] over-long source input is an issue, found before any step runs', () => {
    const r = runNamingPipeline(rp('a', 'b'), src('K', 'a'.repeat(257)));
    expect(r).toMatchObject({
      ok: false,
      issue: { params: { cause: 'input-too-long', max: 256 } },
    });
    expect(runNamingPipeline(rp('a', 'b'), src('K', 'a'.repeat(256))).ok).toBe(true);
  });

  it('[LIF-030] a variable that becomes empty is a pipeline error', () => {
    const k: NamingPipeline = {
      steps: [
        { var: 'repository', op: 'slug' },
        { var: 'repository', op: 'kebab' },
      ],
      template: '{repository}',
    };
    expect(runNamingPipeline(k, src('K', '日本語'))).toMatchObject({
      ok: false,
      issue: { params: { cause: 'empty-result' } },
    });
    expect(runNamingPipeline(k, src('K', '---'))).toMatchObject({
      ok: false,
      issue: { params: { cause: 'empty-result' } },
    });
  });

  it('[LIF-030] a pipeline name starting or ending with a separator is a pipeline error', () => {
    const t = (template: string) =>
      runNamingPipeline({ steps: [{ var: 'repository', op: 'slug' }], template }, src('K', 'abc'));
    expect(t('-{repository}')).toMatchObject({
      ok: false,
      issue: { params: { cause: 'edge-separator' } },
    });
    expect(t('{repository}.')).toMatchObject({ ok: false });
    expect(t('{repository}_x')).toEqual({ ok: true, value: 'abc_x' });
  });
});

describe('[LIF-031] .git suffix and case folding (ADR-0095)', () => {
  it('[LIF-031] names ending in .git are invalid, case-insensitively', () => {
    expect(validateTargetName('repo.git', limits)).toMatchObject({
      ok: false,
      issues: [{ reason: 'reserved-suffix' }],
    });
    expect(validateTargetName('repo.GIT', limits).ok).toBe(false);
    expect(validateTargetName('repo.gitx', limits).ok).toBe(true);
  });

  it('[LIF-031] collisionKey drops one trailing .git', () => {
    expect(collisionKey('Repo.git')).toBe(collisionKey('repo'));
    expect(collisionKey('.git')).toBe('.git');
    expect(collisionKey('repo.git', false)).toBe('repo');
    expect(collisionKey('repo.GIT', false)).toBe('repo.GIT');
  });

  it('[LIF-031] full case folding: ß collides with SS, final sigma with sigma', () => {
    expect(collisionKey('Stra\u00dfe')).toBe(collisionKey('STRASSE'));
    expect(collisionKey('\u03a3\u03a3')).toBe(collisionKey('\u03c3\u03c2'));
    expect(collisionKey('\u212a')).toBe('k');
  });

  it('[LIF-031] property: collisionKey is idempotent', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 500; i++) {
      const s = Array.from({ length: Math.floor(rnd() * 8) }, () =>
        String.fromCodePoint(32 + Math.floor(rnd() * 1000)),
      ).join('');
      const k = collisionKey(s);
      expect(collisionKey(k)).toBe(k);
    }
  });

  it('[LIF-031] detectCollisions is deterministic: groups by key, members by id', () => {
    const groups = detectCollisions([
      { id: 'z', name: 'B' },
      { id: 'y', name: 'a' },
      { id: 'x', name: 'b' },
      { id: 'w', name: 'A' },
    ]);
    expect(groups.map((g) => [g.key, g.members.map((m) => m.id)])).toEqual([
      ['a', ['w', 'y']],
      ['b', ['x', 'z']],
    ]);
  });
});

describe('[LIF-031] owned and foreign targets (round 1)', () => {
  const lim = limits;
  const dp = defaultPipeline;
  const mm = (id: string, slug: string, targetRepositoryId?: string) => ({
    id,
    source: src('P', slug),
    rules: { routeDefault: dp },
    ...(targetRepositoryId ? { targetRepositoryId } : {}),
  });

  it('[LIF-031] an owned target never hides a different repository holding the planned name', () => {
    const existing = [
      { id: 'mine', name: 'old-name', hasRefs: true },
      { id: 'other', name: 'p-new', hasRefs: false },
    ];
    expect(
      classifyExistingTarget({ plannedName: 'p-new', targetRepositoryId: 'mine', existing }),
    ).toEqual({
      kind: 'exists-nonempty',
      target: existing[1],
      ownedTargetId: 'mine',
    });
    expect(
      classifyExistingTarget({ plannedName: 'p-new', targetRepositoryId: 'other', existing }).kind,
    ).toBe('owned');
    expect(
      classifyExistingTarget({ plannedName: 'old-name', targetRepositoryId: 'mine', existing })
        .kind,
    ).toBe('owned');
  });

  it('[LIF-031] several existing targets sharing a key fail safe as ambiguous exists-nonempty', () => {
    const existing = [
      { id: 'b', name: 'Dup', hasRefs: false },
      { id: 'a', name: 'dup', hasRefs: false },
    ];
    expect(classifyExistingTarget({ plannedName: 'DUP', existing })).toEqual({
      kind: 'exists-nonempty',
      target: existing[1],
      ambiguous: true,
    });
    const owned = [...existing, { id: 'mine', name: 'x', hasRefs: true }];
    expect(
      classifyExistingTarget({ plannedName: 'dup', targetRepositoryId: 'mine', existing: owned }),
    ).toMatchObject({ ambiguous: true, ownedTargetId: 'mine' });
  });

  it('[LIF-031] planRouteNaming reports a renamed-owned target colliding with a foreign repository', () => {
    const plan = planRouteNaming([mm('a', 'new', 'mine')], lim, [
      { id: 'mine', name: 'old', hasRefs: true },
      { id: 'other', name: 'p-new', hasRefs: true },
    ]);
    expect(plan.entries[0]?.findings).toEqual([
      {
        code: 'target.exists-nonempty',
        severity: 'blocker',
        params: { name: 'p-new', targetId: 'other', ownedTargetId: 'mine' },
      },
    ]);
  });

  it('[LIF-031] an empty target owned by another Migration is not silently adopted', () => {
    const plan = planRouteNaming([mm('a', 'one', 't1'), mm('b', 't1name')], lim, [
      { id: 't1', name: 'p-t1name', hasRefs: false },
    ]);
    const b = plan.entries[1];
    expect(b?.blocked).toBe(true);
    expect(b?.findings).toEqual([
      {
        code: 'target.owned-by-other-migration',
        severity: 'blocker',
        params: { name: 'p-t1name', targetId: 't1', with: ['a'] },
      },
    ]);
  });

  it('[LIF-031] a non-empty target owned by another Migration also reports ownership, not exists-nonempty', () => {
    const plan = planRouteNaming([mm('a', 'one', 't1'), mm('b', 't1name')], lim, [
      { id: 't1', name: 'p-t1name', hasRefs: true },
    ]);
    expect(plan.entries[1]?.findings.map((f) => f.code)).toEqual([
      'target.owned-by-other-migration',
    ]);
  });

  it('[LIF-031] the same targetRepositoryId on two Migrations blocks all involved', () => {
    const plan = planRouteNaming(
      [mm('c', 'x', 'dup'), mm('a', 'y', 'dup'), mm('b', 'z', 'dup')],
      lim,
    );
    for (const e of plan.entries) {
      expect(e.blocked).toBe(true);
      expect(e.findings[0]).toMatchObject({
        code: 'target.owned-by-other-migration',
        params: { targetId: 'dup' },
      });
    }
    expect(plan.entries[0]?.findings[0]?.params.with).toEqual(['a', 'b']);
  });

  it('[LIF-031] duplicate ownership is reported even when the name is invalid', () => {
    const bad = { ...mm('a', 'x', 'dup'), rules: { routeDefault: dp, override: 'bad name' } };
    const plan = planRouteNaming([bad, mm('b', 'y', 'dup')], lim);
    expect(plan.entries[0]?.findings.map((f) => f.code)).toEqual([
      'target.owned-by-other-migration',
      'naming.invalid',
    ]);
  });

  it('[LIF-031] finding params carry data only, no English message', () => {
    const plan = planRouteNaming(
      [{ ...mm('a', 'x'), rules: { routeDefault: dp, override: 'bad name' } }],
      lim,
    );
    const params = plan.entries[0]?.findings[0]?.params ?? {};
    expect(params).toMatchObject({ reason: 'invalid-characters' });
    expect(params).not.toHaveProperty('message');
    const p2 = planRouteNaming(
      [{ ...mm('a', 'x'), rules: { routeDefault: { steps: [], template: '{q}' } } }],
      lim,
    );
    expect(p2.entries[0]?.findings[0]?.params).toMatchObject({
      reason: 'pipeline',
      cause: 'uninitialized-variable',
    });
    expect(p2.entries[0]?.findings[0]?.params).not.toHaveProperty('message');
  });
});

describe('[LIF-031] NFKC before the .git rule (round 2)', () => {
  it('[LIF-031] a fullwidth .git suffix is rejected and stripped', () => {
    const l: NamingLimits = { ...limits, pattern: /^.+$/u };
    expect(validateTargetName('repo\uff0egit', l)).toMatchObject({
      ok: false,
      issues: [{ reason: 'reserved-suffix' }],
    });
    expect(validateTargetName('\uff0e\uff0e', l)).toMatchObject({
      ok: false,
      issues: [{ reason: 'reserved-name' }],
    });
    expect(collisionKey('repo\uff0egit')).toBe('repo');
    expect(collisionKey('Repo\uff0eGIT', false)).toBe('Repo\uff0eGIT'.normalize('NFKC'));
  });
});
