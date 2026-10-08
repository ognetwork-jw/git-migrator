/**
 * Facet drivers: read-only (no `apply`; Bitbucket is the source, so every Facet is `write: false`,
 * ADP-011). Each read captures its raw responses (ADP-061) and returns schema-valid canonical data.
 */
import {
  AdapterError,
  type AdapterWarning,
  type FacetDriver,
  type FacetRead,
  type FacetTarget,
} from '@git-migrator/adapter-sdk';
import {
  type CanonicalData,
  type FacetKey,
  type PrincipalEntry,
  parseCanonical,
} from '@git-migrator/canonical';
import { formatFieldPath, itemSeg, seg } from '@git-migrator/core';
import { z } from 'zod';
import { enc, getOne, listAll, obj } from './api.ts';
import { PROVIDER } from './config.ts';
import {
  branchingModel,
  deployKeyRow,
  groupGrants,
  groupPermission,
  identityRef,
  mapBranchRules,
  mapChangeRequests,
  mapCodeOwnership,
  mapDeployKeys,
  mapEnvironments,
  mapMergeSettings,
  mapRepositorySettings,
  mapWebhookRows,
  mergeHooks,
  PIPELINES_FILE,
  pipelineFile,
  pullRequestRow,
  restriction,
  reviewerRow,
  splitVariables,
  unionGrants,
  userGrants,
  userPermission,
  variableRow,
  webhookRow,
} from './mappers.ts';
import { type Ctx, Reader } from './reader.ts';

type Read<K extends FacetKey> = FacetRead<CanonicalData<K>>;

function finish<K extends FacetKey>(
  key: K,
  data: unknown,
  extra: {
    unreadable?: string[];
    warnings?: AdapterWarning[];
    rawResponseIds?: string[];
    attachments?: Record<string, string>;
  } = {},
): Read<K> {
  const parsed = parseCanonical(key, data);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)').slice(0, 5);
    throw new AdapterError({
      code: 'invalid',
      provider: PROVIDER,
      message: `The ${key} data read from the provider is not valid canonical data at ${paths.join(', ')}`,
    });
  }
  return {
    data: parsed.data,
    unreadable: extra.unreadable ?? [],
    warnings: extra.warnings ?? [],
    rawResponseIds: [...new Set(extra.rawResponseIds ?? [])],
    ...(extra.attachments !== undefined ? { attachments: extra.attachments } : {}),
  };
}

function repoOf(target: FacetTarget): { slug: string; projectKey: string } {
  if (target.scope !== 'repository') {
    throw new AdapterError({
      code: 'invalid',
      provider: PROVIDER,
      message: 'This Facet reads a repository',
    });
  }
  return { slug: target.repository.slug, projectKey: target.namespace.slug };
}

/** 403 and 404 on an optional read mean "cannot be read" (never a failed Facet). */
async function optional<T>(load: () => Promise<T>): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    if (
      error instanceof AdapterError &&
      (error.code === 'forbidden' || error.code === 'not_found')
    ) {
      return undefined;
    }
    throw error;
  }
}

const branchDoc = obj({ merge_strategies: z.array(z.string()).optional() });
const settingsDoc = obj({ default_branch_deletion: z.unknown().optional() });
const pipelinesConfig = obj({ enabled: z.boolean().optional() });
const sizeDoc = obj({ size: z.number().int().nonnegative().optional() });

export function createFacetDrivers(
  reader: Reader,
): Partial<Record<FacetKey, FacetDriver<unknown>>> {
  const driver = <K extends FacetKey>(
    read: (ctx: Ctx, target: FacetTarget) => Promise<Read<K>>,
  ): FacetDriver<unknown> => ({ read: (ctx, target) => read(ctx, target) });

  return {
    'git-refs': driver<'git-refs'>(async (ctx, target) => {
      repoOf(target);
      const ref = (target as Extract<FacetTarget, { scope: 'repository' }>).repository;
      const credential = await reader.git.credential(ref);
      const result = await ctx.git.lsRemote({
        url: reader.git.remoteUrl(ref),
        credential,
        signal: ctx.signal,
      });
      const refs: CanonicalData<'git-refs'>['refs'] = [];
      const ignoredRefs: string[] = [];
      for (const r of result.refs) {
        if (r.name === 'HEAD') continue;
        if (r.name.startsWith('refs/heads/') || r.name.startsWith('refs/tags/')) {
          refs.push({
            name: r.name,
            kind: r.name.startsWith('refs/heads/') ? 'branch' : 'tag',
            target: r.sha,
            ...(r.peeled !== undefined ? { peeled: r.peeled } : {}),
          });
        } else ignoredRefs.push(r.name);
      }
      const head = result.headSymref;
      return finish('git-refs', {
        defaultBranch: head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : null,
        refs,
        ignoredRefs,
        lfs: {},
      });
    }),

    'repository-settings': driver<'repository-settings'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const { repo, rawResponseIds } = await reader.repository(ctx, slug);
      return finish('repository-settings', mapRepositorySettings(repo), { rawResponseIds });
    }),

    'merge-settings': driver<'merge-settings'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const r = Reader.req(ctx);
      const { repo, rawResponseIds } = await reader.repository(ctx, slug);
      const ids = [...rawResponseIds];
      const main = repo.mainbranch?.name ?? undefined;
      // Missing main branch (empty repository): no strategies, and the call is skipped.
      const branch =
        main === undefined
          ? undefined
          : await optional(() =>
              getOne(r, `${reader.repoPath(slug)}/refs/branches/${enc(main)}`, branchDoc, 'branch'),
            );
      const settings = await optional(() =>
        getOne(
          r,
          `${reader.repoPath(slug)}/branching-model/settings`,
          settingsDoc,
          'branching model settings',
        ),
      );
      ids.push(...(branch?.rawResponseIds ?? []), ...(settings?.rawResponseIds ?? []));
      const { data, unreadable } = mapMergeSettings({
        strategies: branch?.data?.merge_strategies,
        deleteBranchOnMerge: settings?.data?.default_branch_deletion,
      });
      return finish('merge-settings', data, { unreadable, rawResponseIds: ids });
    }),

    'access-control': driver<'access-control'>(async (ctx, target) => {
      const { slug, projectKey } = repoOf(target);
      const r = Reader.req(ctx);
      const base = `${reader.repoPath(slug)}/permissions-config`;
      const [users, groups, project, legacy, owners] = await Promise.all([
        listAll(r, `${base}/users`, userPermission, 'repository user permissions'),
        listAll(r, `${base}/groups`, groupPermission, 'repository group permissions'),
        reader.projectPermissions(ctx, projectKey),
        reader.legacyGroups(ctx),
        reader.owners(ctx),
      ]);
      const defaults = (legacy.groups ?? []).flatMap((g) =>
        groupGrants([{ permission: g.permission ?? 'none', group: { slug: g.slug } }]),
      );
      const warnings: AdapterWarning[] = [];
      if (owners.ids === null) {
        warnings.push({ code: 'access-control.workspace-owners-unknown', paths: [], params: {} });
      }
      const data = unionGrants(
        [
          ...userGrants(users.items),
          ...groupGrants(groups.items),
          ...userGrants(project.users.items),
          ...groupGrants(project.groups.items),
          ...defaults,
        ],
        owners.ids ?? new Set(),
      );
      return finish('access-control', data, {
        warnings,
        rawResponseIds: [
          ...users.rawResponseIds,
          ...groups.rawResponseIds,
          ...project.users.rawResponseIds,
          ...project.groups.rawResponseIds,
          ...legacy.rawResponseIds,
          ...owners.rawResponseIds,
        ],
      });
    }),

    'branch-rules': driver<'branch-rules'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const r = Reader.req(ctx);
      const [restrictions, model] = await Promise.all([
        listAll(
          r,
          `${reader.repoPath(slug)}/branch-restrictions`,
          restriction,
          'branch restrictions',
        ),
        getOne(
          r,
          `${reader.repoPath(slug)}/effective-branching-model`,
          branchingModel,
          'branching model',
        ),
      ]);
      const { rules, warnings } = mapBranchRules(restrictions.items, model.data ?? {});
      return finish(
        'branch-rules',
        { rules },
        { warnings, rawResponseIds: [...restrictions.rawResponseIds, ...model.rawResponseIds] },
      );
    }),

    webhooks: driver<'webhooks'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const rows = await listAll(
        Reader.req(ctx),
        `${reader.repoPath(slug)}/hooks`,
        webhookRow,
        'webhooks',
      );
      return hooksRead('webhooks', rows.items, 'repository', rows.rawResponseIds);
    }),

    'deploy-keys': driver<'deploy-keys'>(async (ctx, target) => {
      const { slug, projectKey } = repoOf(target);
      const [own, project] = await Promise.all([
        listAll(
          Reader.req(ctx),
          `${reader.repoPath(slug)}/deploy-keys`,
          deployKeyRow,
          'deploy keys',
        ),
        reader.projectDeployKeys(ctx, projectKey),
      ]);
      const { data, skipped } = mapDeployKeys([...own.items, ...project.items]);
      return finish('deploy-keys', data, {
        warnings:
          skipped > 0
            ? [{ code: 'deploy-keys.unparsable-skipped', paths: [], params: { count: skipped } }]
            : [],
        rawResponseIds: [...own.rawResponseIds, ...project.rawResponseIds],
      });
    }),

    variables: driver<'variables'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const v = await reader.repoVariables(ctx, slug);
      const { variables, warnings, rawResponseIds } = collectVariables(v);
      return finish('variables', { variables: variables.variables }, { warnings, rawResponseIds });
    }),

    secrets: driver<'secrets'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const v = await reader.repoVariables(ctx, slug);
      const { variables, warnings, rawResponseIds } = collectVariables(v);
      return finish('secrets', { secrets: variables.secrets }, { warnings, rawResponseIds });
    }),

    environments: driver<'environments'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const envs = await reader.environments(ctx, slug);
      return finish('environments', mapEnvironments(envs.items), {
        rawResponseIds: envs.rawResponseIds,
      });
    }),

    pipelines: driver<'pipelines'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const r = Reader.req(ctx);
      const { repo, rawResponseIds } = await reader.repository(ctx, slug);
      const ids = [...rawResponseIds];
      const config = await getOne(
        r,
        `${reader.repoPath(slug)}/pipelines_config`,
        pipelinesConfig,
        'pipelines config',
        {
          optional: true,
        },
      );
      ids.push(...config.rawResponseIds);
      const main = repo.mainbranch?.name ?? undefined;
      const unreadable: string[] = [];
      const files: { path: string; sha256: string }[] = [];
      const attachments: Record<string, string> = {};
      if (main === undefined) unreadable.push('/files');
      else {
        const res = await optional(() =>
          // The file body is not captured (ADP-061): only its sha256 is kept.
          ctx.http.request<unknown>({
            path: `${reader.repoPath(slug)}/src/${enc(main)}/${PIPELINES_FILE}`,
            pool: ctx.pool,
            signal: ctx.signal,
            capture: false,
          }),
        );
        if (res !== undefined) {
          if (res.rawResponseId !== undefined) ids.push(res.rawResponseId);
          const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? '');
          const file = pipelineFile(text);
          files.push(file);
          // The text itself is handed to the Analysis in memory only (ADR-0311).
          attachments[file.sha256] = text;
        }
      }
      return finish(
        'pipelines',
        {
          files,
          enabled: config.data?.enabled === true,
          // Computed in translate; nothing is known to be unsupported at read time.
          translation: { supported: true, unsupported: [] },
        },
        { unreadable, rawResponseIds: ids, attachments },
      );
    }),

    'code-ownership': driver<'code-ownership'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const rows = await listAll(
        Reader.req(ctx),
        `${reader.repoPath(slug)}/effective-default-reviewers`,
        reviewerRow,
        'default reviewers',
      );
      return finish('code-ownership', mapCodeOwnership(rows.items), {
        rawResponseIds: rows.rawResponseIds,
      });
    }),

    'change-requests': driver<'change-requests'>(async (ctx, target) => {
      const { slug } = repoOf(target);
      const rows = await listAll(
        Reader.req(ctx),
        `${reader.repoPath(slug)}/pullrequests`,
        pullRequestRow,
        'pull requests',
        { state: 'OPEN', fields: 'values.id,values.title,values.links.html,next,size' },
      );
      return finish('change-requests', mapChangeRequests(rows.items), {
        rawResponseIds: rows.rawResponseIds,
      });
    }),

    extras: driver<'extras'>(async (ctx, targetArg) => {
      const { slug } = repoOf(targetArg);
      const target = targetArg as Extract<FacetTarget, { scope: 'repository' }>;
      const r = Reader.req(ctx);
      const { repo, rawResponseIds } = await reader.repository(ctx, slug);
      const ids = [...rawResponseIds];
      const unreadable: string[] = [];
      let wikiPopulated = false;
      if (repo.has_wiki === true) {
        try {
          const wiki = await ctx.git.lsRemote({
            url: `${reader.git.remoteUrl(target.repository)}/wiki`,
            credential: await reader.git.credential(target.repository),
            signal: ctx.signal,
          });
          wikiPopulated = wiki.refs.length > 0;
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          unreadable.push('/wikiPopulated'); // ADR-0036 item 3: wiki unreadable
        }
      }
      let issueCount = 0;
      if (repo.has_issues === true) {
        const issues = await getOne(r, `${reader.repoPath(slug)}/issues`, sizeDoc, 'issues', {
          query: { pagelen: 1, fields: 'size' },
          optional: true,
        });
        ids.push(...issues.rawResponseIds);
        if (issues.data?.size !== undefined) issueCount = issues.data.size;
        else if (issues.data !== undefined) unreadable.push('/issueCount');
      }
      const downloads = await getOne(
        r,
        `${reader.repoPath(slug)}/downloads`,
        sizeDoc,
        'downloads',
        {
          query: { pagelen: 1, fields: 'size' },
        },
      );
      ids.push(...downloads.rawResponseIds);
      let downloadCount = 0;
      // `size` is optional in paged responses (ADR-0036 item 5): absent means unknown.
      if (downloads.data?.size !== undefined) downloadCount = downloads.data.size;
      else unreadable.push('/downloadCount');
      return finish(
        'extras',
        { wikiPopulated, issueCount, downloadCount, releaseCount: 0 },
        { unreadable, rawResponseIds: ids },
      );
    }),

    members: driver<'members'>(async (ctx) => {
      const rows = await listAll(
        Reader.req(ctx),
        `${reader.wsPath()}/members`,
        obj({ user: obj({ account_id: z.string().optional(), uuid: z.string().optional() }) }),
        'members',
      );
      const owners = await reader.owners(ctx);
      const members = new Map<
        string,
        { principal: { kind: 'identity'; id: string }; role: 'member' | 'admin' }
      >();
      for (const row of rows.items) {
        const ref = identityRef(row.user);
        if (ref === undefined) continue;
        members.set(ref.id, {
          principal: { kind: 'identity', id: ref.id },
          role: owners.ids?.has(ref.id) ? 'admin' : 'member',
        });
      }
      return finish(
        'members',
        { members: [...members.values()] },
        {
          warnings:
            owners.ids === null ? [{ code: 'members.roles-unknown', paths: [], params: {} }] : [],
          rawResponseIds: [...rows.rawResponseIds, ...owners.rawResponseIds],
        },
      );
    }),

    teams: driver<'teams'>(async (ctx) => {
      const legacy = await reader.legacyGroups(ctx);
      if (legacy.groups !== null) {
        const teams = legacy.groups.map((g) => ({
          slug: g.slug,
          name: g.name ?? g.slug,
          members: dedupe(
            (g.members ?? []).flatMap((m) => {
              const ref = identityRef(m);
              return ref === undefined ? [] : [{ principal: ref }];
            }),
          ),
        }));
        return finish('teams', { teams }, { rawResponseIds: legacy.rawResponseIds });
      }
      // Fallback (ADR-0036 item 2): group names from permission lists, membership unreadable.
      const found = await discoverGroups(reader, ctx);
      const teams = found.groups.map((g) => ({ slug: g.slug, name: g.name, members: [] }));
      return finish(
        'teams',
        { teams },
        {
          unreadable: teams.map((t) =>
            formatFieldPath([itemSeg('teams', 'slug', t.slug), seg('members')]),
          ),
          rawResponseIds: found.rawResponseIds,
        },
      );
    }),

    'org-variables': driver<'org-variables'>(async (ctx) => {
      const rows = await listAll(
        Reader.req(ctx),
        `${reader.wsPath()}/pipelines-config/variables`,
        variableRow,
        'workspace variables',
      );
      const { variables } = splitVariables('workspace', rows.items);
      return finish(
        'org-variables',
        { variables: variables.map((v) => ({ name: v.name, value: v.value, visibility: 'all' })) },
        { rawResponseIds: rows.rawResponseIds },
      );
    }),

    'org-secrets': driver<'org-secrets'>(async (ctx) => {
      const rows = await listAll(
        Reader.req(ctx),
        `${reader.wsPath()}/pipelines-config/variables`,
        variableRow,
        'workspace variables',
      );
      const { secrets } = splitVariables('workspace', rows.items);
      return finish(
        'org-secrets',
        { secrets: secrets.map((s) => ({ name: s.name })) },
        { rawResponseIds: rows.rawResponseIds },
      );
    }),

    'org-webhooks': driver<'org-webhooks'>(async (ctx) => {
      const rows = await listAll(
        Reader.req(ctx),
        `${reader.wsPath()}/hooks`,
        webhookRow,
        'workspace webhooks',
      );
      return hooksRead('org-webhooks', rows.items, 'workspace', rows.rawResponseIds);
    }),
  };

  function hooksRead<K extends 'webhooks' | 'org-webhooks'>(
    key: K,
    rows: Parameters<typeof mapWebhookRows>[0],
    scope: string,
    rawResponseIds: string[],
  ): Read<K> {
    const mapped = mapWebhookRows(rows, scope);
    const merged = mergeHooks(mapped.hooks);
    return finish(
      key,
      { hooks: merged.hooks },
      {
        warnings: [...mapped.warnings, ...merged.warnings],
        rawResponseIds,
      },
    );
  }
}

function dedupe(list: PrincipalEntry[]): PrincipalEntry[] {
  return [...new Map(list.map((e) => [e.principal.id, e])).values()];
}

function collectVariables(v: Awaited<ReturnType<Reader['repoVariables']>>) {
  const repo = splitVariables('repository', v.repoVars.items);
  const variables = [...repo.variables];
  const secrets = [...repo.secrets];
  let skipped = repo.skipped.length;
  for (const env of v.perEnv) {
    const part = splitVariables(`environment:${env.name}`, env.vars.items);
    variables.push(...part.variables);
    secrets.push(...part.secrets);
    skipped += part.skipped.length;
  }
  return {
    variables: { variables, secrets },
    warnings:
      skipped > 0
        ? [{ code: 'variables.invalid-name-skipped', paths: [], params: { count: skipped } }]
        : [],
    rawResponseIds: [
      ...v.repoVars.rawResponseIds,
      ...v.envs.rawResponseIds,
      ...v.perEnv.flatMap((e) => e.vars.rawResponseIds),
    ],
  };
}

/** Group names that appear in project and repository permission lists (membership unknown). */
export async function discoverGroups(
  reader: Reader,
  ctx: Ctx,
): Promise<{ groups: { slug: string; name: string }[]; rawResponseIds: string[] }> {
  const r = Reader.req(ctx);
  const found = new Map<string, string>();
  const ids: string[] = [];
  const add = (rows: readonly z.infer<typeof groupPermission>[]) => {
    for (const row of rows) {
      if (row.group !== undefined) {
        found.set(row.group.slug, (row.group as { name?: string }).name ?? row.group.slug);
      }
    }
  };
  const projects = await listAll(
    r,
    `${reader.wsPath()}/projects`,
    obj({ key: z.string() }),
    'projects',
  );
  ids.push(...projects.rawResponseIds);
  for (const p of projects.items) {
    const perms = await reader.projectPermissions(ctx, p.key);
    add(perms.groups.items);
    ids.push(...perms.groups.rawResponseIds);
  }
  const repos = await listAll(
    r,
    `/2.0/repositories/${enc(reader.workspace)}`,
    obj({ slug: z.string() }),
    'repositories',
    { fields: 'values.slug,next' },
    { capture: false },
  );
  for (const repo of repos.items) {
    const groups = await listAll(
      r,
      `${reader.repoPath(repo.slug)}/permissions-config/groups`,
      groupPermission,
      'repository group permissions',
      {},
      { capture: false },
    );
    add(groups.items);
  }
  return {
    groups: [...found]
      .map(([slug, name]) => ({ slug, name }))
      .sort((a, b) => (a.slug < b.slug ? -1 : 1)),
    rawResponseIds: ids,
  };
}
