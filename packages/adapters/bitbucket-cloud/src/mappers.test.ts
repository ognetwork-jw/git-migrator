/**
 * Mapper unit tests over raw fixtures of real response shapes (`fixtures/`). Each fixture is first
 * validated against Atlassian's published OpenAPI document (so it cannot drift from the reference),
 * then fed through the mapper of its Facet.
 */
import { readFileSync } from 'node:fs';
import { parseCanonical } from '@git-migrator/canonical';
import { bitbucket } from '@git-migrator/provider-fakes';
import { describe, expect, it } from 'vitest';
import { repository } from './api.ts';
import {
  branchingModel,
  branchingModelPattern,
  deployKeyRow,
  environmentRow,
  globToCanonical,
  groupGrants,
  mapBranchRules,
  mapChangeRequests,
  mapCodeOwnership,
  mapDeployKeys,
  mapEnvironments,
  mapEvent,
  mapForking,
  mapMergeSettings,
  mapMergeStrategies,
  mapRepositorySettings,
  mapRole,
  mapWebhookRows,
  mergeHooks,
  normalizePublicKey,
  parseBoolish,
  restriction,
  splitVariables,
  unionGrants,
  userGrants,
  userPermission,
  variableRow,
  webhookRow,
} from './mappers.ts';

const load = (name: string): ReturnType<typeof JSON.parse> =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

describe('raw fixtures match the published API reference (TST-010)', () => {
  const cases: [string, string, string][] = [
    ['repository.json', '/repositories/{workspace}/{repo_slug}', 'get'],
    [
      'branch-restrictions.json',
      '/repositories/{workspace}/{repo_slug}/branch-restrictions',
      'get',
    ],
    [
      'effective-branching-model.json',
      '/repositories/{workspace}/{repo_slug}/effective-branching-model',
      'get',
    ],
    [
      'branching-model-settings.json',
      '/repositories/{workspace}/{repo_slug}/branching-model/settings',
      'get',
    ],
    ['branch-main.json', '/repositories/{workspace}/{repo_slug}/refs/branches/{name}', 'get'],
    ['webhooks.json', '/repositories/{workspace}/{repo_slug}/hooks', 'get'],
    ['deploy-keys.json', '/repositories/{workspace}/{repo_slug}/deploy-keys', 'get'],
    [
      'pipeline-variables.json',
      '/repositories/{workspace}/{repo_slug}/pipelines_config/variables',
      'get',
    ],
    ['environments.json', '/repositories/{workspace}/{repo_slug}/environments', 'get'],
    [
      'permissions-users.json',
      '/repositories/{workspace}/{repo_slug}/permissions-config/users',
      'get',
    ],
    ['workspace-permissions.json', '/workspaces/{workspace}/permissions', 'get'],
  ];
  for (const [file, template, method] of cases) {
    it(`[TST-010] ${file} conforms to ${template}`, () => {
      expect(bitbucket.validateAgainstSpec(method, template, 200, load(file)).errors).toEqual([]);
    });
  }
});

describe('repository-settings mapper (FAC-SET)', () => {
  it('[FAC-SET-001] maps the repository fixture', () => {
    const repo = repository.parse(load('repository.json'));
    expect(mapRepositorySettings(repo)).toEqual({
      description: 'Automatic migration candidate',
      homepage: 'https://example.com/auto-ok',
      visibility: 'private',
      features: { issues: true, wiki: false },
      forking: 'private-only',
    });
  });

  it('[FAC-SET-001] fork_policy maps allow_forks, no_public_forks and no_forks', () => {
    expect(mapForking('allow_forks')).toBe('allowed');
    expect(mapForking('no_public_forks')).toBe('private-only');
    expect(mapForking('no_forks')).toBe('disallowed');
    expect(mapForking(undefined)).toBe('allowed');
  });

  it('[FAC-SET-001] a blank website is null, a null description is empty, public repositories are public', () => {
    expect(
      mapRepositorySettings({ is_private: false, website: '  ', description: null }),
    ).toMatchObject({
      homepage: null,
      description: '',
      visibility: 'public',
      features: { issues: false, wiki: false },
    });
  });
});

describe('merge-settings mapper (FAC-MRG, ADR-0101)', () => {
  it('[FAC-MRG-001] squash_fast_forward is squash, rebase_* are rebase, fast_forward is fast-forward-only', () => {
    expect(
      mapMergeStrategies([
        'merge_commit',
        'squash',
        'squash_fast_forward',
        'rebase_merge',
        'rebase_fast_forward',
        'fast_forward',
      ]),
    ).toEqual(['merge-commit', 'squash', 'rebase', 'fast-forward-only']);
    expect(mapMergeStrategies(['squash_fast_forward'])).toEqual(['squash']);
    expect(mapMergeStrategies(['something_new'])).toEqual([]);
  });

  it('[FAC-MRG-002] reads the branch fixture and the string default_branch_deletion', () => {
    const strategies = load('branch-main.json').merge_strategies;
    const settings = load('branching-model-settings.json');
    const out = mapMergeSettings({
      strategies,
      deleteBranchOnMerge: settings.default_branch_deletion,
    });
    expect(out).toEqual({
      data: {
        allowed: ['merge-commit', 'squash', 'rebase', 'fast-forward-only'],
        deleteBranchOnMerge: true,
      },
      unreadable: [],
    });
    expect(parseCanonical('merge-settings', out.data).success).toBe(true);
  });

  it('[FAC-MRG-002] accepts string or boolean and marks unreadable fields', () => {
    expect(parseBoolish('true')).toBe(true);
    expect(parseBoolish(' FALSE ')).toBe(false);
    expect(parseBoolish(true)).toBe(true);
    expect(parseBoolish('yes')).toBeUndefined();
    expect(parseBoolish(undefined)).toBeUndefined();
    expect(
      mapMergeSettings({ strategies: undefined, deleteBranchOnMerge: undefined }).unreadable,
    ).toEqual(['/allowed', '/deleteBranchOnMerge']);
  });

  it('[FAC-MRG-002] a readable but empty strategy set is unreadable, not "nothing allowed"', () => {
    expect(mapMergeSettings({ strategies: [], deleteBranchOnMerge: 'false' })).toMatchObject({
      data: { allowed: [], deleteBranchOnMerge: false },
      unreadable: ['/allowed'],
    });
  });
});

describe('access-control mapper (FAC-ACL-001)', () => {
  it('[FAC-ACL-001] roles: read, write, admin, and create-repo as write; none is dropped', () => {
    expect(mapRole('read')).toBe('read');
    expect(mapRole('write')).toBe('write');
    expect(mapRole('create-repo')).toBe('write');
    expect(mapRole('admin')).toBe('admin');
    expect(mapRole('none')).toBeUndefined();
    expect(mapRole('superuser')).toBeUndefined();
  });

  it('[FAC-ACL-001] the fixture maps users to account ids', () => {
    const rows = load('permissions-users.json').values.map((v: unknown) => userPermission.parse(v));
    expect(userGrants(rows)).toEqual([
      {
        principal: { kind: 'identity', id: '557058:11111111-aaaa-bbbb-cccc-000000000001' },
        role: 'write',
      },
      {
        principal: { kind: 'identity', id: '557058:22222222-aaaa-bbbb-cccc-000000000002' },
        role: 'read',
      },
    ]);
  });

  it('[FAC-ACL-001] a principal that appears more than once gets the maximum role; owners are excluded', () => {
    const id = (x: string) => ({ kind: 'identity' as const, id: x });
    const out = unionGrants(
      [
        { principal: id('a'), role: 'read' },
        { principal: id('a'), role: 'admin' },
        { principal: id('a'), role: 'write' },
        { principal: id('owner'), role: 'read' },
        { principal: { kind: 'group', id: 'g' }, role: 'write' },
      ],
      new Set(['owner']),
    );
    expect(out.grants).toEqual([
      { principal: { kind: 'group', id: 'g' }, role: 'write' },
      { principal: id('a'), role: 'admin' },
    ]);
  });

  it('[FAC-ACL-001] group and user permission rows without ids or valid roles are skipped', () => {
    expect(
      groupGrants([{ permission: 'write' }, { permission: 'none', group: { slug: 'x' } }]),
    ).toEqual([]);
    expect(userGrants([{ permission: 'read' }, { permission: 'read', user: {} }])).toEqual([]);
  });
});

describe('branch-rules mapper (FAC-BRR-001, FAC-BRR-003)', () => {
  const restrictions = load('branch-restrictions.json').values.map((v: unknown) =>
    restriction.parse(v),
  );
  const model = branchingModel.parse(load('effective-branching-model.json'));
  const { rules, warnings } = mapBranchRules(restrictions, model);
  const rule = (pattern: string) => rules.find((r) => r.pattern === pattern);

  it('[FAC-BRR-001] produces schema-valid rules grouped by pattern, in pattern order', () => {
    expect(parseCanonical('branch-rules', { rules }).success).toBe(true);
    expect(rules.map((r) => r.pattern)).toEqual(['**', 'feature/**', 'main', 'release/**']);
  });

  it('[FAC-BRR-003] Bitbucket * crosses / so it becomes canonical **', () => {
    expect(globToCanonical('*')).toBe('**');
    expect(globToCanonical('release/*')).toBe('release/**');
    expect(globToCanonical('a/**/b')).toBe('a/**/b');
    expect(globToCanonical('main')).toBe('main');
  });

  it('[FAC-BRR-001] push restricts to the listed users and groups', () => {
    expect(rule('main')?.restrictPushes).toEqual([
      { principal: { kind: 'group', id: 'developers' } },
      { principal: { kind: 'identity', id: '557058:11111111-aaaa-bbbb-cccc-000000000001' } },
    ]);
    expect(rule('main')?.restrictMerges).toBeNull();
  });

  it('[FAC-BRR-001] force and delete block with the listed exemptions', () => {
    expect(rule('**')).toMatchObject({
      blockForcePush: true,
      forcePushExempt: [],
      blockDeletion: false,
    });
    expect(rule('release/**')).toMatchObject({
      blockDeletion: true,
      deletionExempt: [
        { principal: { kind: 'identity', id: '557058:22222222-aaaa-bbbb-cccc-000000000002' } },
      ],
    });
  });

  it('[FAC-BRR-001] merge checks map to changeRequest', () => {
    expect(rule('main')?.changeRequest).toEqual({
      minApprovals: 2,
      requireCodeOwnerApproval: false,
      dismissStaleApprovals: false,
      requireNoChangesRequested: false,
      requireTasksResolved: false,
      requireUpToDate: false,
      minPassingBuilds: 1,
    });
    expect(rule('**')?.changeRequest).toBeNull();
  });

  it('[FAC-BRR-001] every remaining kind maps to its changeRequest field', () => {
    const kinds: Record<string, string> = {
      require_default_reviewer_approvals_to_merge: 'requireCodeOwnerApproval',
      reset_pullrequest_approvals_on_change: 'dismissStaleApprovals',
      require_no_changes_requested: 'requireNoChangesRequested',
      require_tasks_to_be_completed: 'requireTasksResolved',
      require_commits_behind: 'requireUpToDate',
    };
    for (const [kind, field] of Object.entries(kinds)) {
      const out = mapBranchRules([restriction.parse({ id: 1, kind, pattern: 'x' })], {});
      expect(out.rules[0]?.changeRequest, kind).toMatchObject({ [field]: true });
    }
  });

  it('[FAC-BRR-001] enforcement is advisory unless enforce_merge_checks exists for the pattern (Standard)', () => {
    expect(rule('main')?.enforcement).toBe('enforced'); // enforce_merge_checks present on main
    expect(rule('feature/**')?.enforcement).toBe('advisory'); // merge-check derived, no enforce kind
    expect(rule('**')?.enforcement).toBe('enforced'); // no merge-check part
    const standard = mapBranchRules(
      [restriction.parse({ id: 1, kind: 'require_approvals_to_merge', pattern: 'x', value: 1 })],
      {},
    );
    expect(standard.rules[0]?.enforcement).toBe('advisory');
  });

  it('[FAC-BRR-001] branching_model restrictions become globs from the model prefix', () => {
    expect(rule('feature/**')?.changeRequest?.requireUpToDate).toBe(true);
    const r = (type: string) =>
      restriction.parse({
        id: 1,
        kind: 'push',
        pattern: '',
        branch_match_kind: 'branching_model',
        branch_type: type,
      });
    expect(branchingModelPattern(r('hotfix'), model)).toBe('hotfix/**');
    expect(branchingModelPattern(r('development'), model)).toBe('develop');
    expect(branchingModelPattern(r('production'), model)).toBe('main');
    expect(branchingModelPattern(r('release'), model)).toBeUndefined();
  });

  it('[FAC-BRR-001] an unresolvable branching-model type is reported, not guessed', () => {
    const out = mapBranchRules(
      [
        restriction.parse({
          id: 1,
          kind: 'push',
          pattern: '',
          branch_match_kind: 'branching_model',
          branch_type: 'release',
        }),
      ],
      model,
    );
    expect(out.rules).toEqual([]);
    expect(
      out.warnings.find((w) => w.code === 'branch-rules.branching-model')?.params
        .unresolvedBranchTypes,
    ).toEqual(['release']);
  });

  it('[FAC-BRR-001] unmapped kinds are warning branch-rules.unknown-kind with the pattern, not rules', () => {
    expect(warnings.filter((w) => w.code === 'branch-rules.unknown-kind')).toEqual([
      {
        code: 'branch-rules.unknown-kind',
        paths: ['/rules[pattern=main]'],
        params: { kind: 'smart_reset_pullrequest_approvals', pattern: 'main' },
      },
    ]);
  });

  it('[FAC-BRR-001] the branching model is reported once as warning branch-rules.branching-model', () => {
    const w = warnings.filter((x) => x.code === 'branch-rules.branching-model');
    expect(w).toHaveLength(1);
    expect(w[0]?.params).toMatchObject({
      prefixes: ['feature/', 'hotfix/'],
      development: 'develop',
      production: 'main',
    });
  });

  it('[FAC-BRR-001] restrictions that land on one canonical pattern combine strictest-first', () => {
    const out = mapBranchRules(
      [
        restriction.parse({
          id: 1,
          kind: 'push',
          pattern: 'a/*',
          users: [{ account_id: 'u1' }, { account_id: 'u2' }],
        }),
        restriction.parse({
          id: 2,
          kind: 'push',
          pattern: 'a/**',
          users: [{ account_id: 'u2' }, { account_id: 'u3' }],
        }),
        restriction.parse({ id: 3, kind: 'require_approvals_to_merge', pattern: 'a/*', value: 1 }),
        restriction.parse({ id: 4, kind: 'require_approvals_to_merge', pattern: 'a/**', value: 3 }),
      ],
      {},
    );
    expect(out.rules).toHaveLength(1);
    expect(out.rules[0]?.restrictPushes).toEqual([{ principal: { kind: 'identity', id: 'u2' } }]);
    expect(out.rules[0]?.changeRequest?.minApprovals).toBe(3);
  });

  it('[FAC-BRR-001] a restriction with an empty pattern is reported, not silently dropped', () => {
    const out = mapBranchRules([restriction.parse({ id: 1, kind: 'push', pattern: '' })], {});
    expect(out.rules).toEqual([]);
    expect(out.warnings).toEqual([
      {
        code: 'branch-rules.unknown-kind',
        paths: [],
        params: { kind: 'push', reason: 'empty-pattern' },
      },
    ]);
  });

  it('[FAC-BRR-001] restrictions without a pattern and users without ids are ignored', () => {
    const out = mapBranchRules(
      [
        restriction.parse({ id: 1, kind: 'push', pattern: null }),
        restriction.parse({ id: 2, kind: 'push', pattern: 'p', users: [{}] }),
      ],
      {},
    );
    expect(out.rules).toEqual([expect.objectContaining({ pattern: 'p', restrictPushes: [] })]);
  });
});

describe('webhooks mapper (FAC-WEB-001)', () => {
  it('[FAC-WEB-001] maps the event table', () => {
    const table: Record<string, string | undefined> = {
      'repo:push': 'push',
      'pullrequest:created': 'cr.opened',
      'pullrequest:updated': 'cr.updated',
      'pullrequest:fulfilled': 'cr.merged',
      'pullrequest:rejected': 'cr.declined',
      'pullrequest:comment_created': 'cr.comment',
      'pullrequest:comment_resolved': 'cr.comment',
      'pullrequest:approved': 'cr.approved',
      'pullrequest:changes_request_created': 'cr.changes_requested',
      'repo:commit_status_created': 'build.status',
      'repo:commit_status_updated': 'build.status',
      'repo:updated': 'repo.updated',
      'repo:fork': 'repo.fork',
      'issue:created': 'issue.any',
      'issue:comment_created': 'issue.any',
      'project:updated': undefined,
      'pullrequest:unapproved': undefined,
      'repo:commit_comment_created': undefined,
    };
    for (const [bb, canonical] of Object.entries(table)) expect(mapEvent(bb), bb).toBe(canonical);
  });

  it('[FAC-WEB-001] the fixture maps secret presence, activity and TLS verification', () => {
    const rows = load('webhooks.json').values.map((v: unknown) => webhookRow.parse(v));
    const { hooks, warnings } = mapWebhookRows(rows, 'repository');
    expect(hooks[0]).toEqual({
      url: 'https://ci.example.com/hooks/bitbucket',
      events: ['build.status', 'cr.comment', 'cr.merged', 'cr.opened', 'push'],
      active: true,
      hasSecret: true,
      verifyTls: true,
    });
    expect(hooks[1]).toMatchObject({
      active: false,
      hasSecret: false,
      events: ['issue.any', 'repo.fork'],
    });
    expect(warnings).toEqual([
      {
        code: 'webhooks.unmapped-events',
        paths: [],
        params: { scope: 'repository', events: ['project:updated'] },
      },
    ]);
  });

  it('[FAC-WEB-004] skip_cert_verification turns verifyTls off', () => {
    const { hooks } = mapWebhookRows(
      [webhookRow.parse({ url: 'https://h.example/x', skip_cert_verification: true })],
      's',
    );
    expect(hooks[0]?.verifyTls).toBe(false);
  });

  it('[FAC-WEB-002] invalid, credentialed and non-http URLs are dropped with a count only', () => {
    const rows = ['nope', 'ftp://h.example/x', 'https://u:p@h.example/x'].map((url) =>
      webhookRow.parse({ url }),
    );
    const out = mapWebhookRows(rows, 'repository');
    expect(out.hooks).toEqual([]);
    expect(out.warnings).toEqual([
      { code: 'webhooks.invalid-url', paths: [], params: { scope: 'repository', count: 3 } },
    ]);
  });

  it('[FAC-WEB-002] duplicate normalized URLs merge: events united, any active or secret, TLS only if all', () => {
    const base = { events: [] as never[], active: false, hasSecret: false, verifyTls: true };
    const { hooks, warnings } = mergeHooks([
      { ...base, url: 'https://h.example/z', events: ['push'], active: true },
      {
        ...base,
        url: 'https://h.example/z',
        events: ['cr.opened'],
        hasSecret: true,
        verifyTls: false,
      },
      { ...base, url: 'https://h.example/other' },
    ]);
    expect(hooks).toHaveLength(2);
    const merged = hooks.find((h) => h.url.endsWith('/z'));
    expect(merged).toMatchObject({
      events: ['cr.opened', 'push'],
      active: true,
      hasSecret: true,
      verifyTls: false,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('webhooks.duplicate-url');
    expect(warnings[0]?.params).toEqual({ targetUrlDisplay: 'https://h.example/…', count: 2 });
    expect(parseCanonical('webhooks', { hooks }).success).toBe(true);
  });
});

describe('deploy-keys mapper (FAC-DKY-001)', () => {
  it('[FAC-DKY-001] strips the comment, keeps the label, read-only', () => {
    const rows = load('deploy-keys.json').values.map((v: unknown) => deployKeyRow.parse(v));
    const { data } = mapDeployKeys(rows);
    expect(data.keys).toEqual([
      {
        publicKey:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
        title: 'build agent',
        readOnly: true,
      },
    ]);
    expect(parseCanonical('deploy-keys', data).success).toBe(true);
  });

  it('[FAC-DKY-001] a key on repository and project appears once; unparsable keys are counted', () => {
    const out = mapDeployKeys([
      deployKeyRow.parse({ key: 'ssh-rsa AAAA a@b', label: 'repo' }),
      deployKeyRow.parse({ key: 'ssh-rsa   AAAA   other comment', label: 'project' }),
      deployKeyRow.parse({ key: '-----BEGIN PRIVATE KEY-----' }),
      deployKeyRow.parse({ key: 'justonetoken' }),
    ]);
    expect(out.data.keys).toEqual([{ publicKey: 'ssh-rsa AAAA', title: 'repo', readOnly: true }]);
    expect(out.skipped).toBe(2);
    expect(normalizePublicKey('  ssh-ed25519 AAA  ')).toBe('ssh-ed25519 AAA');
  });

  it('[FAC-DKY-001] a missing label falls back to the comment, then to empty', () => {
    const out = mapDeployKeys([
      deployKeyRow.parse({ key: 'ssh-rsa A', comment: 'c' }),
      deployKeyRow.parse({ key: 'ssh-rsa B' }),
    ]);
    expect(out.data.keys.map((k) => k.title)).toEqual(['c', '']);
  });
});

describe('variables, secrets and environments mappers (FAC-VAR, FAC-SEC, FAC-ENV)', () => {
  it('[FAC-VAR-001] secured variables become secrets without a value; others keep theirs', () => {
    const rows = load('pipeline-variables.json').values.map((v: unknown) => variableRow.parse(v));
    const out = splitVariables('repository', rows);
    expect(out.variables).toEqual([
      { key: 'repository/NODE_ENV', scope: 'repository', name: 'NODE_ENV', value: 'production' },
    ]);
    expect(out.secrets).toEqual([
      { key: 'repository/NPM_TOKEN', scope: 'repository', name: 'NPM_TOKEN' },
    ]);
    expect(parseCanonical('variables', { variables: out.variables }).success).toBe(true);
    expect(parseCanonical('secrets', { secrets: out.secrets }).success).toBe(true);
  });

  it('[FAC-VAR-001] environment scope uses environment:<name>; names with / are skipped and counted', () => {
    const out = splitVariables('environment:Production', [
      variableRow.parse({ key: 'A', value: '1' }),
      variableRow.parse({ key: 'a/b', value: '1' }),
    ]);
    expect(out.variables.map((v) => v.key)).toEqual(['environment:Production/A']);
    expect(out.skipped).toHaveLength(1);
  });

  it('[FAC-ENV] maps the environment type to a category and leaves deployment branches null', () => {
    const rows = load('environments.json').values.map((v: unknown) => environmentRow.parse(v));
    expect(mapEnvironments(rows)).toEqual({
      environments: [{ name: 'Production', category: 'production', deploymentBranches: null }],
    });
    const odd = mapEnvironments([
      environmentRow.parse({ uuid: '{1}', name: 'B', environment_type: { name: 'Custom' } }),
      environmentRow.parse({ uuid: '{2}', name: 'A', environment_type: { name: 'Test' } }),
    ]);
    expect(odd.environments.map((e) => [e.name, e.category])).toEqual([
      ['A', 'test'],
      ['B', null],
    ]);
  });
});

describe('code-ownership and change-requests mappers (FAC-COD, FAC-CRQ)', () => {
  it('[FAC-COD] default reviewers become one * entry, deduplicated and sorted', () => {
    const user = (id: string) => ({ user: { account_id: id } });
    expect(mapCodeOwnership([user('b'), user('a'), user('b'), {}])).toEqual({
      owners: [
        {
          pattern: '*',
          principals: [
            { principal: { kind: 'identity', id: 'a' } },
            { principal: { kind: 'identity', id: 'b' } },
          ],
        },
      ],
    });
    expect(mapCodeOwnership([])).toEqual({ owners: [] });
  });

  it('[FAC-CRQ] open pull requests keep id, title and HTML link; a missing link never hides one', () => {
    const out = mapChangeRequests([
      {
        id: 7,
        title: 'Fix',
        links: { html: { href: 'https://bitbucket.org/acme/r/pull-requests/7' } },
      },
      { id: 8 },
    ] as never);
    expect(out.open).toEqual([
      { id: '7', title: 'Fix', url: 'https://bitbucket.org/acme/r/pull-requests/7' },
      { id: '8', title: '', url: 'unavailable' },
    ]);
    expect(parseCanonical('change-requests', out).success).toBe(true);
  });
});
