import { paginate } from '../link.ts';
import { type Out, orgFor, type Req, type Router } from '../router.ts';
import { type GitHubState, nodeId, validSecretName } from '../state.ts';
import type { EnvironmentRec, HookRec, RepoRec, SecretRec, VariableRec } from '../types.ts';
import { GhError, invalidField, notFound, validationFailed } from '../util.ts';

/** Repository, environment and organization secrets (names only), variables, webhooks, environments. */

interface Scope {
  secrets: SecretRec[];
  variables: VariableRec[];
}

type ScopeOf = (q: Req) => Scope;

const PUBLIC_KEY = {
  key_id: '568250167242549743',
  key: 'Zml4ZWQta2V5LWZvci10aGUtZmFrZS1naXRodWItMzI=',
};

function listOut<T, U>(
  q: Req,
  items: T[],
  map: (t: T) => U,
  field: string,
  defaults: { perPage: number; max: number },
): Out {
  const paged = paginate(items, q.url, defaults);
  return {
    body: { total_count: paged.total, [field]: paged.items.map(map) },
    headers: paged.link ? { link: paged.link } : undefined,
  };
}

function find<T extends { name: string }>(list: T[], name: string): T {
  const found = list.find((x) => x.name === name.toUpperCase());
  if (!found) throw notFound();
  return found;
}

export function registerScopes(r: Router, state: GitHubState): void {
  const repoScope: ScopeOf = (q) => q.repo();
  const envScope: ScopeOf = (q) => findEnv(q.repo(), q.param('env'));
  const orgScope: ScopeOf = (q) => orgFor(q, q.param('org'));

  secrets(r, state, '/repos/:owner/:repo/actions', repoScope, 'secrets', false);
  secrets(r, state, '/repos/:owner/:repo/environments/:env', envScope, 'environments', false);
  secrets(r, state, '/orgs/:org/actions', orgScope, 'organization_secrets', true);
  variables(r, state, '/repos/:owner/:repo/actions', repoScope, 'actions_variables', false);
  variables(r, state, '/repos/:owner/:repo/environments/:env', envScope, 'environments', false);
  variables(r, state, '/orgs/:org/actions', orgScope, 'organization_actions_variables', true);
  hooks(r, state, '/repos/:owner/:repo', (q) => q.repo(), 'repository_hooks', true);
  hooks(r, state, '/orgs/:org', (q) => orgFor(q, q.param('org')), 'organization_hooks', false);
  environments(r, state);
}

function findEnv(repo: RepoRec, name: string): EnvironmentRec {
  const env = repo.environments.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!env) throw notFound();
  return env;
}

function selectedRepos(state: GitHubState, q: Req, ids: number[]) {
  return ids
    .map((id) => [...state.repos.values()].find((x) => x.id === id))
    .filter((x): x is RepoRec => !!x)
    .map((x) => q.ser.repoMinimal(x));
}

function applyVisibility(
  state: GitHubState,
  q: Req,
  rec: SecretRec,
  body: Record<string, unknown>,
): void {
  const visibility = body.visibility as string | undefined;
  if (visibility !== undefined) {
    if (!['all', 'private', 'selected'].includes(visibility))
      throw invalidField('Secret', 'visibility');
    rec.visibility = visibility as SecretRec['visibility'];
  }
  const ids = (body.selected_repository_ids ?? body.selected_repository_ids) as
    | (number | string)[]
    | undefined;
  if (ids) rec.selectedRepositoryIds = ids.map(Number);
  if (rec.visibility !== 'selected') rec.selectedRepositoryIds = [];
  void state;
  void q;
}

function selectionRoutes(
  r: Router,
  state: GitHubState,
  base: string,
  scopeOf: ScopeOf,
  kind: 'secrets' | 'variables',
  perm: string,
): void {
  const get = (q: Req): SecretRec => find(scopeOf(q)[kind] as SecretRec[], q.param('name'));
  const needSelected = (rec: SecretRec) => {
    if (rec.visibility !== 'selected')
      throw new GhError(409, 'The visibility of the resource is not "selected".');
  };
  r.get(`${base}/:name/repositories`, [perm, 'read'], (q) => {
    const rec = get(q);
    needSelected(rec);
    const repos = selectedRepos(state, q, rec.selectedRepositoryIds);
    return listOut(q, repos, (x) => x, 'repositories', { perPage: 30, max: 100 });
  });
  r.put(`${base}/:name/repositories`, [perm, 'write'], async (q) => {
    const rec = get(q);
    needSelected(rec);
    const body = await q.body();
    rec.selectedRepositoryIds = ((body.selected_repository_ids as number[] | undefined) ?? []).map(
      Number,
    );
    return {};
  });
  r.put(`${base}/:name/repositories/:rid`, [perm, 'write'], (q) => {
    const rec = get(q);
    needSelected(rec);
    const id = Number(q.param('rid'));
    if (!rec.selectedRepositoryIds.includes(id)) rec.selectedRepositoryIds.push(id);
    return {};
  });
  r.delete(`${base}/:name/repositories/:rid`, [perm, 'write'], (q) => {
    const rec = get(q);
    needSelected(rec);
    rec.selectedRepositoryIds = rec.selectedRepositoryIds.filter(
      (i) => i !== Number(q.param('rid')),
    );
    return {};
  });
}

function secrets(
  r: Router,
  state: GitHubState,
  prefix: string,
  scopeOf: ScopeOf,
  perm: string,
  org: boolean,
): void {
  const base = `${prefix}/secrets`;
  r.get(base, [perm, 'read'], (q) =>
    listOut(q, scopeOf(q).secrets, (s) => q.ser.secret(s, org), 'secrets', {
      perPage: 30,
      max: 100,
    }),
  );
  r.get(`${base}/public-key`, [perm, 'read'], (q) => {
    scopeOf(q);
    return { body: PUBLIC_KEY };
  });
  r.get(`${base}/:name`, [perm, 'read'], (q) => ({
    body: q.ser.secret(find(scopeOf(q).secrets, q.param('name')), org),
  }));
  r.put(`${base}/:name`, [perm, 'write'], async (q) => {
    const scope = scopeOf(q);
    const body = await q.body();
    if (typeof body.encrypted_value !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.encrypted_value))
      throw validationFailed({
        resource: 'Secret',
        code: 'custom',
        field: 'encrypted_value',
        message: 'encrypted_value is not a valid Base64 string',
      });
    if (body.key_id !== PUBLIC_KEY.key_id)
      throw validationFailed({
        resource: 'Secret',
        code: 'custom',
        field: 'key_id',
        message: 'key_id does not match the current public key',
      });
    const { rec, created } = state.putNamed(scope.secrets, q.param('name'), {}, () =>
      state.newSecret(),
    );
    if (org) applyVisibility(state, q, rec, body);
    return created ? { status: 201, body: {} } : {};
  });
  r.delete(`${base}/:name`, [perm, 'write'], (q) => {
    const scope = scopeOf(q);
    const rec = find(scope.secrets, q.param('name'));
    scope.secrets.splice(scope.secrets.indexOf(rec), 1);
    return {};
  });
  if (org) selectionRoutes(r, state, base, scopeOf, 'secrets', perm);
}

function variables(
  r: Router,
  state: GitHubState,
  prefix: string,
  scopeOf: ScopeOf,
  perm: string,
  org: boolean,
): void {
  const base = `${prefix}/variables`;
  r.get(base, [perm, 'read'], (q) =>
    listOut(q, scopeOf(q).variables, (v) => q.ser.variable(v, org), 'variables', {
      perPage: 10,
      max: 30,
    }),
  );
  r.post(base, [perm, 'write'], async (q) => {
    const scope = scopeOf(q);
    const body = await q.body();
    if (typeof body.name !== 'string' || typeof body.value !== 'string')
      throw validationFailed({ resource: 'Variable', code: 'missing_field', field: 'name' });
    if (!validSecretName(body.name)) throw invalidField('Variable', 'name');
    const varName = body.name;
    if (scope.variables.some((v) => v.name === varName.toUpperCase()))
      throw new GhError(409, 'Variable already exists');
    const { rec } = state.putNamed(scope.variables, varName, { value: body.value }, () =>
      state.newVariable(body.value as string),
    );
    if (org) applyVisibility(state, q, rec, body);
    return { status: 201, body: {} };
  });
  r.get(`${base}/:name`, [perm, 'read'], (q) => ({
    body: q.ser.variable(find(scopeOf(q).variables, q.param('name')), org),
  }));
  r.patch(`${base}/:name`, [perm, 'write'], async (q) => {
    const scope = scopeOf(q);
    const rec = find(scope.variables, q.param('name'));
    const body = await q.body();
    if (typeof body.value === 'string') rec.value = body.value;
    if (typeof body.name === 'string' && body.name.toUpperCase() !== rec.name) {
      if (!validSecretName(body.name)) throw invalidField('Variable', 'name');
      if (scope.variables.some((v) => v.name === (body.name as string).toUpperCase()))
        throw new GhError(409, 'Variable already exists');
      rec.name = body.name.toUpperCase();
    }
    if (org) applyVisibility(state, q, rec, body);
    rec.updatedAt = state.clock();
    return {};
  });
  r.delete(`${base}/:name`, [perm, 'write'], (q) => {
    const scope = scopeOf(q);
    const rec = find(scope.variables, q.param('name'));
    scope.variables.splice(scope.variables.indexOf(rec), 1);
    return {};
  });
  if (org) selectionRoutes(r, state, base, scopeOf, 'variables', perm);
}

type HookScope = { hooks: HookRec[] };

function hooks(
  r: Router,
  state: GitHubState,
  prefix: string,
  scopeOf: (q: Req) => HookScope,
  perm: string,
  isRepo: boolean,
): void {
  const base = `${prefix}/hooks`;
  const urlBase = (q: Req) =>
    q.url.origin +
    (isRepo ? `/repos/${q.param('owner')}/${q.param('repo')}` : `/orgs/${q.param('org')}`);
  const hookOf = (q: Req): HookRec => {
    const h = scopeOf(q).hooks.find((x) => x.id === Number(q.param('id')));
    if (!h) throw notFound();
    return h;
  };
  const ser = (q: Req, h: HookRec) => ({
    ...q.ser.hook(urlBase(q), h),
    type: isRepo ? 'Repository' : 'Organization',
  });
  const mergeConfig = (h: HookRec, config: Record<string, unknown> | undefined) => {
    if (!config) return;
    for (const k of ['url', 'content_type', 'secret', 'insecure_ssl'] as const) {
      const v = config[k];
      if (v !== undefined)
        (h.config as Record<string, unknown>)[k] = typeof v === 'number' ? String(v) : v;
    }
  };

  r.get(base, [perm, 'read'], (q) => q.page(scopeOf(q).hooks, (h) => ser(q, h)));
  r.post(base, [perm, 'write'], async (q) => {
    const scope = scopeOf(q);
    const body = await q.body();
    const config = (body.config ?? {}) as Record<string, unknown>;
    if (typeof config.url !== 'string' || !/^https?:\/\//.test(config.url))
      throw validationFailed({
        resource: 'Hook',
        code: 'custom',
        field: 'url',
        message: 'url must be an http(s) URL',
      });
    if (scope.hooks.some((h) => h.config.url === config.url))
      throw validationFailed({
        resource: 'Hook',
        code: 'custom',
        message: `Hook already exists on this ${isRepo ? 'repository' : 'organization'}`,
      });
    const rec = state.addHook(scope, {
      url: config.url,
      events: (body.events as string[] | undefined) ?? ['push'],
      active: (body.active as boolean | undefined) ?? true,
    });
    mergeConfig(rec, config);
    return { status: 201, body: ser(q, rec) };
  });
  r.get(`${base}/:id`, [perm, 'read'], (q) => ({ body: ser(q, hookOf(q)) }));
  r.patch(`${base}/:id`, [perm, 'write'], async (q) => {
    const h = hookOf(q);
    const body = await q.body();
    mergeConfig(h, body.config as Record<string, unknown> | undefined);
    if (Array.isArray(body.events)) h.events = body.events as string[];
    if (Array.isArray(body.add_events))
      h.events = [...new Set([...h.events, ...(body.add_events as string[])])];
    if (Array.isArray(body.remove_events))
      h.events = h.events.filter((e) => !(body.remove_events as string[]).includes(e));
    if (typeof body.active === 'boolean') h.active = body.active;
    h.updatedAt = state.clock();
    return { body: ser(q, h) };
  });
  r.delete(`${base}/:id`, [perm, 'write'], (q) => {
    const scope = scopeOf(q);
    const h = hookOf(q);
    scope.hooks.splice(scope.hooks.indexOf(h), 1);
    return {};
  });
  r.get(`${base}/:id/config`, [perm, 'read'], (q) => ({ body: q.ser.hookConfig(hookOf(q)) }));
  r.patch(`${base}/:id/config`, [perm, 'write'], async (q) => {
    const h = hookOf(q);
    mergeConfig(h, await q.body());
    h.updatedAt = state.clock();
    return { body: q.ser.hookConfig(h) };
  });
  r.get(`${base}/:id/deliveries`, [perm, 'read'], (q) => {
    hookOf(q);
    return { body: [] };
  });
  r.get(`${base}/:id/deliveries/:did`, [perm, 'read'], (q) => {
    hookOf(q);
    throw notFound();
  });
  r.post(`${base}/:id/deliveries/:did/attempts`, [perm, 'write'], (q) => {
    hookOf(q);
    throw notFound();
  });
  r.post(`${base}/:id/pings`, [perm, 'write'], (q) => {
    hookOf(q);
    return {};
  });
  if (isRepo)
    r.post(`${base}/:id/tests`, [perm, 'write'], (q) => {
      hookOf(q);
      return {};
    });
}

function environments(r: Router, state: GitHubState): void {
  const base = '/repos/:owner/:repo/environments';
  const policyOf = (q: Req) => {
    const env = findEnv(q.repo(), q.param('env'));
    const p = env.branchPolicies.find((x) => x.id === Number(q.param('pid')));
    if (!p) throw notFound();
    return { env, p };
  };
  const policyBody = (p: EnvironmentRec['branchPolicies'][number]) => ({
    id: p.id,
    node_id: p.nodeId,
    name: p.name,
    type: p.type,
  });

  r.get(base, ['actions', 'read'], (q) => {
    const repo = q.repo();
    return listOut(q, repo.environments, (e) => q.ser.environment(repo, e), 'environments', {
      perPage: 30,
      max: 100,
    });
  });
  r.get(`${base}/:env`, ['actions', 'read'], (q) => {
    const repo = q.repo();
    return { body: q.ser.environment(repo, findEnv(repo, q.param('env'))) };
  });
  // Creating or updating an environment needs Administration: write, not Environments (provider doc).
  r.put(`${base}/:env`, ['administration', 'write'], async (q) => {
    const repo = q.repo();
    const body = await q.body();
    const reviewers =
      (body.reviewers as { type: 'User' | 'Team'; id: number }[] | null | undefined) ?? [];
    const waitTimer = (body.wait_timer as number | undefined) ?? 0;
    if (reviewers.length > 6) throw invalidField('Environment', 'reviewers', 'at most 6 reviewers');
    if (typeof waitTimer !== 'number' || waitTimer < 0 || waitTimer > 43200)
      throw invalidField('Environment', 'wait_timer');
    const policy = body.deployment_branch_policy as
      | { protected_branches?: boolean; custom_branch_policies?: boolean }
      | null
      | undefined;
    if (policy && policy.protected_branches === policy.custom_branch_policies)
      throw validationFailed({
        resource: 'Environment',
        code: 'custom',
        field: 'deployment_branch_policy',
        message: 'exactly one of protected_branches and custom_branch_policies must be true',
      });
    const wantsProtection = reviewers.length > 0 || waitTimer > 0;
    const org = state.requireOrg(repo.owner);
    const restricted = repo.private && org.plan.name !== 'enterprise';
    if (wantsProtection && restricted && state.config.environmentProtection === 'reject')
      throw validationFailed({
        resource: 'Environment',
        code: 'custom',
        field: reviewers.length ? 'reviewers' : 'wait_timer',
        message:
          'required reviewers and wait timers are not available for private repositories on this plan',
      });
    const env = state.addEnvironment(repo, q.param('env'));
    const keep = !(wantsProtection && restricted);
    env.reviewers = keep ? reviewers : [];
    env.waitTimer = keep ? waitTimer : 0;
    env.preventSelfReview = body.prevent_self_review === true;
    if (policy !== undefined)
      env.deploymentBranchPolicy = policy
        ? {
            protectedBranches: !!policy.protected_branches,
            customBranchPolicies: !!policy.custom_branch_policies,
          }
        : null;
    env.updatedAt = state.clock();
    return { body: q.ser.environment(repo, env) };
  });
  r.delete(`${base}/:env`, ['administration', 'write'], (q) => {
    const repo = q.repo();
    const env = findEnv(repo, q.param('env'));
    repo.environments.splice(repo.environments.indexOf(env), 1);
    return {};
  });

  const pbase = `${base}/:env/deployment-branch-policies`;
  r.get(pbase, ['actions', 'read'], (q) => {
    const env = findEnv(q.repo(), q.param('env'));
    return listOut(q, env.branchPolicies, (p) => policyBody(p), 'branch_policies', {
      perPage: 30,
      max: 100,
    });
  });
  r.post(pbase, ['administration', 'write'], async (q) => {
    const env = findEnv(q.repo(), q.param('env'));
    if (!env.deploymentBranchPolicy?.customBranchPolicies)
      return {
        status: 303,
        body: undefined,
        headers: {
          location: `${q.url.origin}/repos/${q.param('owner')}/${q.param('repo')}/environments/${env.name}`,
        },
      };
    const body = await q.body();
    if (typeof body.name !== 'string' || !body.name)
      throw validationFailed({
        resource: 'DeploymentBranchPolicy',
        code: 'missing_field',
        field: 'name',
      });
    const type = (body.type as 'branch' | 'tag' | undefined) ?? 'branch';
    if (type !== 'branch' && type !== 'tag') throw invalidField('DeploymentBranchPolicy', 'type');
    if (env.branchPolicies.some((p) => p.name === body.name && p.type === type))
      throw validationFailed({
        resource: 'DeploymentBranchPolicy',
        code: 'already_exists',
        field: 'name',
      });
    env.nextPolicyId += 1;
    const p = {
      id: state.nextId('policy', 13000),
      nodeId: nodeId('DeploymentBranchPolicy', env.nextPolicyId),
      name: body.name,
      type,
    };
    env.branchPolicies.push(p);
    return { body: policyBody(p) };
  });
  r.get(`${pbase}/:pid`, ['actions', 'read'], (q) => ({ body: policyBody(policyOf(q).p) }));
  r.put(`${pbase}/:pid`, ['administration', 'write'], async (q) => {
    const { p } = policyOf(q);
    const body = await q.body();
    if (typeof body.name !== 'string' || !body.name)
      throw validationFailed({
        resource: 'DeploymentBranchPolicy',
        code: 'missing_field',
        field: 'name',
      });
    p.name = body.name;
    return { body: policyBody(p) };
  });
  r.delete(`${pbase}/:pid`, ['administration', 'write'], (q) => {
    const { env, p } = policyOf(q);
    env.branchPolicies.splice(env.branchPolicies.indexOf(p), 1);
    return {};
  });
}
