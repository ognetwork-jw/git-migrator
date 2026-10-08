import { readFileSync } from 'node:fs';
import {
  CollectionError,
  canonicalize,
  flattenDocument,
  normalizeDocument,
  validateCollections,
} from '@git-migrator/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  type AccessControl,
  type BranchRules,
  CANONICAL_FACETS,
  type CanonicalData,
  type ChangeRequests,
  type CodeOwnership,
  type DeployKeys,
  declareFacet,
  type Environments,
  type Extras,
  FACET_KEYS,
  type FacetKey,
  type GitRefs,
  getCanonicalFacet,
  type Members,
  type MergeSettings,
  type OrgSecrets,
  type OrgVariables,
  type OrgWebhooks,
  type Pipelines,
  parseCanonical,
  type RepositorySettings,
  redactWebhookUrl,
  type Secrets,
  scopedKey,
  type Teams,
  type Variables,
  type Webhooks,
  webhookKey,
} from './index.ts';

const sha = 'a'.repeat(40);
const id = (n: string) => ({ kind: 'identity' as const, id: n });
const grp = (n: string) => ({ kind: 'group' as const, id: n });
const pe = (p: { kind: 'identity' | 'group'; id: string }) => ({ principal: p });
const hex64 = 'f'.repeat(64);

const hook: Webhooks['hooks'][number] = {
  key: webhookKey('https://ci.example.com/hook'),
  url: 'https://ci.example.com/hook',
  events: ['cr.opened', 'push'],
  active: true,
  hasSecret: false,
  verifyTls: true,
};

const rule = {
  pattern: 'main',
  enforcement: 'enforced',
  restrictPushes: [pe(grp('dev')), pe(id('1'))],
  restrictMerges: null,
  blockForcePush: true,
  forcePushExempt: [],
  blockDeletion: true,
  deletionExempt: [pe(id('9'))],
  changeRequest: {
    minApprovals: 2,
    requireCodeOwnerApproval: false,
    dismissStaleApprovals: true,
    requireNoChangesRequested: true,
    requireTasksResolved: false,
    requireUpToDate: true,
    minPassingBuilds: 0,
  },
};

/** Valid documents per facet, already in normalized form (sorted), so serializing is identity. */
const VALID: Record<FacetKey, unknown[]> = {
  'git-refs': [
    {
      defaultBranch: 'main',
      refs: [
        { name: 'refs/heads/main', kind: 'branch', target: sha },
        { name: 'refs/tags/v1', kind: 'tag', target: 'b'.repeat(40), peeled: sha },
      ],
      ignoredRefs: ['refs/pull/1/head'],
      lfs: { oids: ['x1'], count: 1, bytes: 10 },
    },
    { defaultBranch: null, refs: [], ignoredRefs: [], lfs: {} },
  ],
  'repository-settings': [
    {
      description: 'A repo',
      homepage: null,
      visibility: 'private',
      features: { issues: false, wiki: true },
      forking: 'private-only',
    },
  ],
  'merge-settings': [
    { allowed: ['merge-commit', 'rebase', 'squash'], deleteBranchOnMerge: true },
    { allowed: [], deleteBranchOnMerge: false },
  ],
  'access-control': [
    {
      grants: [
        { principal: grp('dev'), role: 'write' },
        { principal: id('1'), role: 'admin' },
      ],
    },
    { grants: [] },
  ],
  'branch-rules': [
    { rules: [rule, { ...rule, pattern: 'release/**', restrictPushes: [], changeRequest: null }] },
    { rules: [] },
  ],
  webhooks: [{ hooks: [hook] }, { hooks: [] }],
  'deploy-keys': [
    { keys: [{ publicKey: 'ssh-ed25519 AAAA', title: 'ci', readOnly: true }] },
    { keys: [] },
  ],
  variables: [
    {
      variables: [
        { key: 'environment:prod/A', scope: 'environment:prod', name: 'A', value: '1' },
        { key: 'repository/B', scope: 'repository', name: 'B', value: '' },
      ],
    },
  ],
  secrets: [{ secrets: [{ key: 'repository/TOKEN', scope: 'repository', name: 'TOKEN' }] }],
  environments: [
    {
      environments: [
        { name: 'prod', category: 'production', deploymentBranches: ['main'] },
        { name: 'qa', category: null, deploymentBranches: null },
      ],
    },
  ],
  pipelines: [
    {
      files: [{ path: 'ci-pipeline.yml', sha256: hex64 }],
      enabled: true,
      translation: { supported: false, unsupported: ['/pipelines/default/0/step/pipe'] },
    },
  ],
  'code-ownership': [
    { owners: [{ pattern: '*', principals: [pe(grp('rev')), pe(id('1'))] }] },
    { owners: [{ pattern: '*', principals: [] }] },
  ],
  'change-requests': [
    { open: [{ id: '7', title: 'Fix', url: 'https://x.example/7' }] },
    { open: [] },
  ],
  extras: [{ wikiPopulated: true, issueCount: 3, downloadCount: 0, releaseCount: 0 }],
  members: [
    {
      members: [
        { principal: id('1'), role: 'admin' },
        { principal: id('2'), role: 'member' },
      ],
    },
  ],
  teams: [{ teams: [{ slug: 'core', name: 'Core', members: [pe(id('1'))] }] }],
  'org-variables': [{ variables: [{ name: 'X', value: 'y', visibility: 'all' }] }],
  'org-secrets': [{ secrets: [{ name: 'S' }] }],
  'org-webhooks': [{ hooks: [hook] }],
};

/** Invalid documents: [label, document, text the error must mention]. */
const INVALID: Record<FacetKey, [string, unknown, string][]> = {
  'git-refs': [
    [
      'bad kind',
      { ...(VALID['git-refs'][1] as object), refs: [{ name: 'a', kind: 'ref', target: sha }] },
      'refs.0.kind',
    ],
    ['missing ignoredRefs', { defaultBranch: null, refs: [], lfs: {} }, 'ignoredRefs'],
    ['unknown field', { ...(VALID['git-refs'][1] as object), extra: 1 }, 'extra'],
    [
      'negative lfs count',
      { ...(VALID['git-refs'][1] as object), lfs: { count: -1 } },
      'lfs.count',
    ],
  ],
  'repository-settings': [
    [
      'bad visibility',
      { ...(VALID['repository-settings'][0] as object), visibility: 'internal' },
      'visibility',
    ],
    [
      'undefined homepage',
      { ...(VALID['repository-settings'][0] as object), homepage: undefined },
      'homepage',
    ],
  ],
  'merge-settings': [
    ['bad strategy', { allowed: ['octopus'], deleteBranchOnMerge: true }, 'allowed.0'],
    ['non-boolean', { allowed: [], deleteBranchOnMerge: 'yes' }, 'deleteBranchOnMerge'],
  ],
  'access-control': [
    ['bad role', { grants: [{ principal: id('1'), role: 'owner' }] }, 'grants.0.role'],
    [
      'bad principal kind',
      { grants: [{ principal: { kind: 'user', id: '1' }, role: 'read' }] },
      'principal.kind',
    ],
    [
      'numeric principal id',
      { grants: [{ principal: { kind: 'identity', id: 1 }, role: 'read' }] },
      'principal.id',
    ],
  ],
  'branch-rules': [
    [
      'restrictPushes undefined',
      { rules: [{ ...rule, restrictPushes: undefined }] },
      'restrictPushes',
    ],
    [
      'bare PrincipalRef element',
      { rules: [{ ...rule, restrictPushes: [id('1')] }] },
      'restrictPushes.0.principal',
    ],
    [
      'fractional approvals',
      { rules: [{ ...rule, changeRequest: { ...rule.changeRequest, minApprovals: 1.5 } }] },
      'minApprovals',
    ],
    ['bad enforcement', { rules: [{ ...rule, enforcement: 'maybe' }] }, 'enforcement'],
    ['empty pattern', { rules: [{ ...rule, pattern: '' }] }, 'pattern'],
  ],
  webhooks: [
    ['bad event', { hooks: [{ ...hook, events: ['push', 'deploy'] }] }, 'events.1'],
    [
      'missing verifyTls',
      {
        hooks: [
          {
            key: webhookKey('https://u.example/'),
            url: 'https://u.example/',
            events: [],
            active: true,
            hasSecret: false,
          },
        ],
      },
      'verifyTls',
    ],
    ['secret value present', { hooks: [{ ...hook, secret: 'hunter2' }] }, 'secret'],
  ],
  'deploy-keys': [['missing readOnly', { keys: [{ publicKey: 'k', title: 't' }] }, 'readOnly']],
  variables: [
    [
      'key mismatch',
      { variables: [{ key: 'repository/A', scope: 'repository', name: 'B', value: '' }] },
      'key must equal',
    ],
    ['bad scope', { variables: [{ key: 'env/A', scope: 'env', name: 'A', value: '' }] }, 'scope'],
    [
      'slash in name',
      { variables: [{ key: 'repository/a/b', scope: 'repository', name: 'a/b', value: '' }] },
      'name',
    ],
  ],
  secrets: [
    [
      'value present',
      { secrets: [{ key: 'repository/T', scope: 'repository', name: 'T', value: 'x' }] },
      'value',
    ],
    ['key mismatch', { secrets: [{ key: 'T', scope: 'repository', name: 'T' }] }, 'key must equal'],
  ],
  environments: [
    [
      'bad category',
      { environments: [{ name: 'a', category: 'dev', deploymentBranches: null }] },
      'category',
    ],
    [
      'missing deploymentBranches',
      { environments: [{ name: 'a', category: null }] },
      'deploymentBranches',
    ],
  ],
  pipelines: [
    [
      'bad sha256',
      { ...(VALID.pipelines[0] as object), files: [{ path: 'p', sha256: 'XYZ' }] },
      'sha256',
    ],
    ['missing translation', { files: [], enabled: false }, 'translation'],
  ],
  'code-ownership': [
    [
      'bare principals',
      { owners: [{ pattern: '*', principals: [id('1')] }] },
      'principals.0.principal',
    ],
  ],
  'change-requests': [['missing url', { open: [{ id: '1', title: 't' }] }, 'url']],
  extras: [
    [
      'negative count',
      { wikiPopulated: false, issueCount: -1, downloadCount: 0, releaseCount: 0 },
      'issueCount',
    ],
    [
      'string count',
      { wikiPopulated: false, issueCount: '1', downloadCount: 0, releaseCount: 0 },
      'issueCount',
    ],
  ],
  members: [['bad role', { members: [{ principal: id('1'), role: 'owner' }] }, 'members.0.role']],
  teams: [['missing name', { teams: [{ slug: 's', members: [] }] }, 'teams.0.name']],
  'org-variables': [
    [
      'bad visibility',
      { variables: [{ name: 'X', value: '', visibility: 'private' }] },
      'visibility',
    ],
  ],
  'org-secrets': [['value present', { secrets: [{ name: 'S', value: 'x' }] }, 'value']],
  'org-webhooks': [['bad event', { hooks: [{ ...hook, events: ['nope'] }] }, 'events.0']],
};

/** Paths of every array reachable in a Zod schema (`/a/b` form, plain names). */
function arrayPaths(schema: z.ZodType, prefix = ''): { path: string; element: z.ZodType }[] {
  // biome-ignore lint/suspicious/noExplicitAny: introspection of zod internals
  const def = (schema as any).def;
  switch (def.type) {
    case 'optional':
    case 'nullable':
      return arrayPaths(def.innerType, prefix);
    case 'object':
      return Object.entries(def.shape as Record<string, z.ZodType>).flatMap(([k, v]) =>
        arrayPaths(v, `${prefix}/${k}`),
      );
    case 'array':
      return [{ path: prefix, element: def.element }, ...arrayPaths(def.element, prefix)];
    default:
      return [];
  }
}

describe('facet registry', () => {
  it('[FAC-001] exports a schema, scope and schema version for every facet in the index', () => {
    expect(Object.keys(CANONICAL_FACETS).sort()).toEqual([...FACET_KEYS].sort());
    expect(FACET_KEYS).toHaveLength(19);
    for (const key of FACET_KEYS) {
      const f = getCanonicalFacet(key);
      expect(f.key).toBe(key);
      expect(f.schemaVersion).toBe(1);
      expect(f.scope).toBe(
        ['members', 'teams', 'org-variables', 'org-secrets', 'org-webhooks'].includes(key)
          ? 'endpoint'
          : 'repository',
      );
      expect(f.schema.safeParse(VALID[key][0]).success).toBe(true);
      expect(f.documentSchema.collections).toBe(f.collections);
    }
  });

  it('[FAC-001] regression guard: types and schemas agree (compile-time)', () => {
    expectTypeOf<CanonicalData<'git-refs'>>().toEqualTypeOf<GitRefs>();
    expectTypeOf<CanonicalData<'repository-settings'>>().toEqualTypeOf<RepositorySettings>();
    expectTypeOf<CanonicalData<'merge-settings'>>().toEqualTypeOf<MergeSettings>();
    expectTypeOf<CanonicalData<'access-control'>>().toEqualTypeOf<AccessControl>();
    expectTypeOf<CanonicalData<'branch-rules'>>().toEqualTypeOf<BranchRules>();
    expectTypeOf<CanonicalData<'webhooks'>>().toEqualTypeOf<Webhooks>();
    expectTypeOf<CanonicalData<'deploy-keys'>>().toEqualTypeOf<DeployKeys>();
    expectTypeOf<CanonicalData<'variables'>>().toEqualTypeOf<Variables>();
    expectTypeOf<CanonicalData<'secrets'>>().toEqualTypeOf<Secrets>();
    expectTypeOf<CanonicalData<'environments'>>().toEqualTypeOf<Environments>();
    expectTypeOf<CanonicalData<'pipelines'>>().toEqualTypeOf<Pipelines>();
    expectTypeOf<CanonicalData<'code-ownership'>>().toEqualTypeOf<CodeOwnership>();
    expectTypeOf<CanonicalData<'change-requests'>>().toEqualTypeOf<ChangeRequests>();
    expectTypeOf<CanonicalData<'extras'>>().toEqualTypeOf<Extras>();
    expectTypeOf<CanonicalData<'members'>>().toEqualTypeOf<Members>();
    expectTypeOf<CanonicalData<'teams'>>().toEqualTypeOf<Teams>();
    expectTypeOf<CanonicalData<'org-variables'>>().toEqualTypeOf<OrgVariables>();
    expectTypeOf<CanonicalData<'org-secrets'>>().toEqualTypeOf<OrgSecrets>();
    expectTypeOf<CanonicalData<'org-webhooks'>>().toEqualTypeOf<OrgWebhooks>();
    // nullability is preserved: null = unrestricted, [] = nobody
    expectTypeOf<BranchRules['rules'][number]['restrictPushes']>().toEqualTypeOf<
      { principal: { kind: 'identity' | 'group'; id: string } }[] | null
    >();
    expectTypeOf<GitRefs['defaultBranch']>().toEqualTypeOf<string | null>();
  });
});

describe.each(FACET_KEYS)('%s', (key) => {
  const facet = getCanonicalFacet(key);

  it.each(VALID[key].map((d, i) => [i, d] as const))(
    '[FAC-001] round-trips valid document %i without normalization',
    (_i, doc) => {
      const parsed = parseCanonical(key, doc);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data).toEqual(doc);
      expect(canonicalize(JSON.parse(JSON.stringify(parsed.data)))).toBe(canonicalize(doc));
      // idempotent
      expect(parseCanonical(key, parsed.data).success).toBe(true);
    },
  );

  it.each(INVALID[key])('[FAC-001] rejects %s with a useful error', (_label, doc, mention) => {
    const parsed = parseCanonical(key, doc);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const text = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    expect(text).toContain(mention);
  });

  it('[FAC-001] rejects non-objects', () => {
    for (const bad of [null, 'x', 1, []]) expect(parseCanonical(key, bad).success).toBe(false);
  });

  it('[ADP-021] declares exactly the arrays of the schema, each as a collection or a set', () => {
    const arrays = arrayPaths(facet.schema);
    const declared = [...facet.collections.map((c) => c.path), ...facet.sets].sort();
    expect(arrays.map((a) => a.path).sort()).toEqual(declared);
    for (const c of facet.collections) {
      const el = arrays.find((a) => a.path === c.path)?.element;
      // biome-ignore lint/suspicious/noExplicitAny: introspection of zod internals
      const shape = (el as any).def.shape as Record<string, unknown>;
      expect(Object.keys(shape), `${c.path} key field`).toContain(c.key);
    }
    for (const p of facet.sets) {
      // biome-ignore lint/suspicious/noExplicitAny: introspection of zod internals
      expect((arrays.find((a) => a.path === p)?.element as any)?.def.type).not.toBe('object');
    }
  });

  it.each(VALID[key].map((d, i) => [i, d] as const))(
    '[ADP-021] core normalizes valid document %i without changing it',
    (_i, doc) => {
      expect(validateCollections(doc, facet.documentSchema)).toEqual([]);
      expect(normalizeDocument(doc, facet.documentSchema)).toEqual(doc);
      expect(flattenDocument(doc, facet.documentSchema)).toBeInstanceOf(Map);
    },
  );
});

describe('collection behavior', () => {
  const norm = <K extends FacetKey>(k: K, doc: CanonicalData<K>) =>
    normalizeDocument(doc, getCanonicalFacet(k).documentSchema);

  it('[ADP-021] sorts keyed collections and sets', () => {
    const mk = (url: string, o: Partial<Webhooks['hooks'][number]> = {}) => ({
      ...hook,
      ...o,
      url,
      key: webhookKey(url),
    });
    const out = norm('webhooks', {
      hooks: [
        mk('https://b.example/x', { events: ['push', 'cr.opened', 'push'] }),
        mk('https://a.example/x'),
      ],
    });
    expect(out.hooks.map((h) => h.url)).toEqual(['https://a.example/x', 'https://b.example/x']);
    expect(out.hooks[1]?.events).toEqual(['cr.opened', 'push']);
    const m = norm('merge-settings', {
      allowed: ['squash', 'merge-commit'],
      deleteBranchOnMerge: true,
    });
    expect(m.allowed).toEqual(['merge-commit', 'squash']);
  });

  it('[ADP-021] keeps null distinct from [] for restrictPushes and deploymentBranches', () => {
    const r = norm('branch-rules', {
      rules: [{ ...rule, restrictPushes: null, restrictMerges: [] }] as BranchRules['rules'],
    });
    expect(r.rules[0]?.restrictPushes).toBeNull();
    expect(r.rules[0]?.restrictMerges).toEqual([]);
    const e = norm('environments', {
      environments: [
        { name: 'a', category: null, deploymentBranches: null },
        { name: 'b', category: null, deploymentBranches: [] },
      ],
    });
    expect(e.environments.map((x) => x.deploymentBranches)).toEqual([null, []]);
    const flat = flattenDocument(r, getCanonicalFacet('branch-rules').documentSchema);
    expect(flat.get('/rules[pattern=main]/restrictPushes')).toBeNull();
    expect(flat.get('/rules[pattern=main]/restrictMerges')).toEqual([]);
    // the parsed documents keep the distinction too
    expect(parseCanonical('branch-rules', r).success).toBe(true);
  });

  it('[ADP-020] addresses principals as [principal=kind:id]', () => {
    const flat = flattenDocument(
      { rules: [rule] },
      getCanonicalFacet('branch-rules').documentSchema,
    );
    expect([...flat.keys()]).toContain(
      '/rules[pattern=main]/restrictPushes[principal=identity:1]/principal/kind',
    );
    const acl = flattenDocument(
      { grants: [{ principal: grp('developers'), role: 'read' }] },
      getCanonicalFacet('access-control').documentSchema,
    );
    expect(acl.get('/grants[principal=group:developers]/role')).toBe('read');
  });

  it('[ADP-021] sorts principals by kind:id, so group:* precedes identity:*', () => {
    const out = norm('teams', {
      teams: [{ slug: 's', name: 'S', members: [pe(id('2')), pe(grp('z')), pe(id('1'))] }],
    });
    expect(out.teams[0]?.members.map((m) => `${m.principal.kind}:${m.principal.id}`)).toEqual([
      'group:z',
      'identity:1',
      'identity:2',
    ]);
  });

  it('[ADP-021] variables from different scopes with the same name have distinct keys', () => {
    const doc = VALID.variables[0] as Variables;
    expect(new Set(doc.variables.map((v) => v.key)).size).toBe(2);
    expect(scopedKey('environment:prod', 'A')).toBe('environment:prod/A');
    expect(() =>
      norm('variables', {
        variables: [
          { key: 'repository/A', scope: 'repository', name: 'A', value: '1' },
          { key: 'repository/A', scope: 'repository', name: 'A', value: '2' },
        ],
      }),
    ).toThrow(CollectionError);
  });

  it('[ADP-002] depends only on core and zod, and facet keys carry no provider vocabulary', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@git-migrator/core', 'zod']);
    expect(JSON.stringify(FACET_KEYS)).not.toMatch(/bitbucket|github/i); // GLO-002
  });
});

describe('parse-time validation', () => {
  const two = <T>(f: (i: number) => T) => [f(0), f(1)];
  const dupes: [FacetKey, unknown][] = [
    [
      'git-refs',
      {
        ...(VALID['git-refs'][1] as object),
        refs: two(() => ({ name: 'a', kind: 'branch', target: sha })),
      },
    ],
    ['access-control', { grants: two(() => ({ principal: id('1'), role: 'read' })) }],
    ['branch-rules', { rules: [rule, rule] }],
    ['branch-rules', { rules: [{ ...rule, restrictPushes: [pe(id('1')), pe(id('1'))] }] }],
    ['webhooks', { hooks: [hook, { ...hook, events: ['push'] }] }],
    [
      'deploy-keys',
      { keys: two((i) => ({ publicKey: 'ssh-ed25519 AAAA', title: `t${i}`, readOnly: true })) },
    ],
    [
      'variables',
      {
        variables: two((i) => ({
          key: 'repository/A',
          scope: 'repository',
          name: 'A',
          value: `${i}`,
        })),
      },
    ],
    ['secrets', { secrets: two(() => ({ key: 'repository/A', scope: 'repository', name: 'A' })) }],
    [
      'environments',
      { environments: two(() => ({ name: 'a', category: null, deploymentBranches: null })) },
    ],
    [
      'pipelines',
      { ...(VALID.pipelines[0] as object), files: two(() => ({ path: 'p', sha256: hex64 })) },
    ],
    ['code-ownership', { owners: two(() => ({ pattern: '*', principals: [] })) }],
    ['change-requests', { open: two(() => ({ id: '1', title: 't', url: 'u' })) }],
    ['members', { members: two(() => ({ principal: id('1'), role: 'member' })) }],
    ['teams', { teams: two(() => ({ slug: 's', name: 'S', members: [] })) }],
    ['org-variables', { variables: two(() => ({ name: 'X', value: '', visibility: 'all' })) }],
    ['org-secrets', { secrets: two(() => ({ name: 'S' })) }],
    ['org-webhooks', { hooks: [hook, hook] }],
  ];
  it.each(dupes)('[ADP-021] %s: duplicate keys are rejected at parse', (key, doc) => {
    const r = parseCanonical(key, doc);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.reason).toBe('invalid');
    expect(r.error.issues.map((i) => i.message).join('\n')).toMatch(
      /duplicate_key: .* is not unique/,
    );
  });

  it('[FAC-WEB-003] duplicate webhook URLs are rejected without echoing the secret path', () => {
    const url = 'https://chat.example.com/services/T0/B1/SECRETPART';
    const mk = (u: string) => ({ ...hook, url: u, key: webhookKey(u) });
    const r = parseCanonical('webhooks', {
      hooks: [mk(url), mk(`${url}?x=1`.replace('?x=1', ''))],
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    const text = JSON.stringify(r.error.issues);
    expect(text).toContain('duplicate_key');
    expect(text).not.toContain('SECRETPART');
    // flattened field paths and the key never contain the path or query either
    const doc = { hooks: [mk(`${url}?token=Q1`)] };
    const flat = flattenDocument(doc, getCanonicalFacet('webhooks').documentSchema);
    for (const path of flat.keys()) {
      expect(path).not.toContain('SECRETPART');
      expect(path).not.toContain('Q1');
    }
    expect(mk(url).key).toMatch(/^https:\/\/chat\.example\.com#[0-9a-f]{16}$/);
  });

  it('[FAC-WEB-003] the key is derived from the normalized URL', () => {
    expect(webhookKey('HTTPS://CI.Example.com:443/a')).toBe(webhookKey('https://ci.example.com/a'));
    expect(webhookKey('https://ci.example.com/a')).not.toBe(webhookKey('https://ci.example.com/b'));
    const wrong = { hooks: [{ ...hook, key: 'https://ci.example.com#0000000000000000' }] };
    bad('webhooks', wrong, 'key must equal webhookKey(url)');
  });

  it('[FAC-WEB-003] redactWebhookUrl keeps only the origin', () => {
    expect(redactWebhookUrl('https://chat.example.com:8443/services/SECRET?token=1')).toBe(
      'https://chat.example.com:8443/…',
    );
    expect(redactWebhookUrl('nope')).toBe('<invalid url>');
  });

  it('[FAC-001] schema version: matching accepted, other versions are typed failures', () => {
    expect(parseCanonical('extras', VALID.extras[0], { version: 1 }).success).toBe(true);
    const r = parseCanonical('extras', VALID.extras[0], { version: 2 });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.reason).toBe('unsupported_version');
    expect(r.error.issues[0]?.message).toContain('unsupported schema version 2');
  });

  it('[FAC-001] declareFacet takes the schema version as a parameter', () => {
    const f = declareFacet({
      key: 'extras',
      scope: 'repository',
      schema: getCanonicalFacet('extras').schema,
      schemaVersion: 3,
    });
    expect(f.schemaVersion).toBe(3);
  });

  const bad = (key: FacetKey, doc: unknown, mention: string) => {
    const r = parseCanonical(key, doc);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')).toContain(
      mention,
    );
  };

  it('[FAC-DKY-001] deploy key must be "<type> <base64>" without comment or PEM', () => {
    const k = (publicKey: string) => ({ keys: [{ publicKey, title: 't', readOnly: true }] });
    bad('deploy-keys', k('ssh-ed25519 AAAA me@example.com'), 'publicKey');
    bad('deploy-keys', k('-----BEGIN PUBLIC KEY-----'), 'publicKey');
    bad('deploy-keys', k('ssh-ed25519'), 'publicKey');
    bad('deploy-keys', k('-----BEGIN KEY'), 'publicKey');
    expect(parseCanonical('deploy-keys', k('ssh-rsa AAAB3')).success).toBe(true);
  });

  it.each([
    ['not a URL', 'nope'],
    ['non-http scheme', 'ftp://example.com/h'],
    ['userinfo', 'https://user:pw@example.com/h'],
  ])('[FAC-WEB-003] rejects a webhook URL with %s', (_l, url) => {
    const h = { ...hook, url, key: 'k' };
    bad('webhooks', { hooks: [h] }, 'url');
    bad('org-webhooks', { hooks: [h] }, 'url');
  });

  it('[FAC-WEB-003] accepts real hook URLs with credential-like query parameters', () => {
    for (const url of [
      'https://ci.example.com/job?token=abc&author=me',
      'https://example.com/h?room=7',
    ]) {
      expect(
        parseCanonical('webhooks', { hooks: [{ ...hook, url, key: webhookKey(url) }] }).success,
      ).toBe(true);
    }
  });

  it('[FAC-VAR-001] rejects control characters and untrimmed scopes and names', () => {
    const v = (scope: string, name: string) => ({
      variables: [{ key: `${scope}/${name}`, scope, name, value: '' }],
    });
    bad('variables', v('repository', ' A'), 'name');
    bad('variables', v('repository', 'A\n'), 'name');
    bad('variables', v('repository', 'A\u0000B'), 'name');
    bad('variables', v('environment:prod ', 'A'), 'scope');
    bad('variables', v('environment:pr\u0007od', 'A'), 'scope');
    bad('org-secrets', { secrets: [{ name: 'A\tB' }] }, 'name');
    expect(parseCanonical('variables', v('environment:Prod', 'a')).success).toBe(true);
  });

  const principalPaths: [FacetKey, string, (dup: unknown[]) => unknown][] = [
    ['branch-rules', '/rules/restrictPushes', (d) => ({ rules: [{ ...rule, restrictPushes: d }] })],
    ['branch-rules', '/rules/restrictMerges', (d) => ({ rules: [{ ...rule, restrictMerges: d }] })],
    [
      'branch-rules',
      '/rules/forcePushExempt',
      (d) => ({ rules: [{ ...rule, forcePushExempt: d }] }),
    ],
    ['branch-rules', '/rules/deletionExempt', (d) => ({ rules: [{ ...rule, deletionExempt: d }] })],
    ['teams', '/teams/members', (d) => ({ teams: [{ slug: 's', name: 'S', members: d }] })],
    [
      'code-ownership',
      '/owners/principals',
      (d) => ({ owners: [{ pattern: '*', principals: d }] }),
    ],
  ];
  it.each(principalPaths)(
    '[ADP-021] %s %s: duplicate principals are rejected at parse',
    (key, path, build) => {
      expect(
        getCanonicalFacet(key).collections.some((c) => c.path === path && c.key === 'principal'),
      ).toBe(true);
      const r = parseCanonical(key, build([pe(id('1')), pe(id('1'))]));
      expect(r.success).toBe(false);
      if (r.success) return;
      expect(r.error.issues.map((i) => i.message).join()).toMatch(/duplicate_key/);
      expect(parseCanonical(key, build([pe(id('1')), pe(grp('1'))])).success).toBe(true);
    },
  );
});
