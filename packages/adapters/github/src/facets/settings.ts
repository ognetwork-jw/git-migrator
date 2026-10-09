/** deploy-keys, environments, variables, secrets, org-variables and org-secrets drivers. */
import { AdapterError, type FacetDriver } from '@git-migrator/adapter-sdk';
import type {
  DeployKeys,
  Environments,
  OrgSecrets,
  OrgVariables,
  Secrets,
  Variables,
} from '@git-migrator/canonical';
import { scopedKey } from '@git-migrator/canonical';
import { Collector, type Gh, type Json, obj, repoPath, str } from '../gh.ts';
import {
  cannotUndo,
  type DriverDeps,
  ghOf,
  ignoreGone,
  itemPath,
  mutation,
  orgTarget,
  repoTarget,
  sortBy,
} from './common.ts';

// -- deploy-keys --------------------------------------------------------------------------------

/** `<type> <base64>` without the comment (FAC-DKY key rule). */
export function normalizePublicKey(key: string): string {
  const [type, body] = key.trim().split(/\s+/);
  return `${type ?? ''} ${body ?? ''}`;
}

export function deployKeysDriver(deps: DriverDeps): FacetDriver<DeployKeys> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const list = await ghOf(ctx, collector).list<Json>(`${repoPath(deps.org, repo.slug)}/keys`);
      const keys: DeployKeys['keys'] = list.flatMap((k) => {
        const publicKey = normalizePublicKey(str(k.key));
        return /^\S+ \S+$/.test(publicKey)
          ? [{ publicKey, title: str(k.title), readOnly: k.read_only !== false }]
          : [];
      });
      return collector.result({ keys: sortBy(keys, (k) => k.publicKey) });
    },
    async *apply(ctx, target, desired, current) {
      const repo = repoTarget(target);
      const gh = ghOf(ctx);
      const have = new Set(
        (current ?? (await this.read(ctx, target)).data).keys.map((k) => k.publicKey),
      );
      for (const key of sortBy(desired.keys, (k) => k.publicKey)) {
        if (have.has(key.publicKey)) continue;
        try {
          const created = await gh.send<Json>('POST', `${repoPath(deps.org, repo.slug)}/keys`, {
            title: key.title,
            key: key.publicKey,
            read_only: key.readOnly,
          });
          yield mutation(
            'deploy-keys',
            'create',
            { kind: 'deploy-key', repository: repo.slug, id: created.id },
            [itemPath('keys', 'publicKey', key.publicKey)],
            null,
            { title: key.title, readOnly: key.readOnly },
          );
        } catch (error) {
          // FAC-DKY-002: GitHub keys are unique. The step continues; the key stays missing, which
          // the lifecycle turns into the post task `deploy-keys.key-in-use`.
          if (error instanceof AdapterError && error.code === 'conflict') {
            ctx.logger.warn(
              { finding: 'deploy-keys.key-in-use', repository: repo.slug, title: key.title },
              'deploy key already in use on GitHub',
            );
            continue;
          }
          throw error;
        }
      }
    },
    async undo(ctx, target, record) {
      const repo = repoTarget(target);
      if (record.action !== 'create' || record.resourceRef.kind !== 'deploy-key') {
        throw cannotUndo(record);
      }
      await ignoreGone(
        ghOf(ctx).send(
          'DELETE',
          `${repoPath(deps.org, repo.slug)}/keys/${String(record.resourceRef.id)}`,
        ),
      );
    },
  };
}

// -- environments -------------------------------------------------------------------------------

/** Branch policies only; tag policies cannot be represented (the caller warns). */
async function envPolicies(
  gh: Gh,
  base: string,
  name: string,
): Promise<{ branches: string[]; tags: number }> {
  const list = await gh.list<Json>(
    `${base}/environments/${encodeURIComponent(name)}/deployment-branch-policies`,
    {},
    (b) => obj(b).branch_policies,
  );
  const named = list.filter((p) => str(p.name) !== '');
  const isTag = (p: Json) => p.type === 'tag';
  return {
    branches: named.filter((p) => !isTag(p)).map((p) => str(p.name)),
    tags: named.filter(isTag).length,
  };
}

export function environmentsDriver(deps: DriverDeps): FacetDriver<Environments> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const gh = ghOf(ctx, collector);
      const base = repoPath(deps.org, repo.slug);
      const list = await gh.list<Json>(`${base}/environments`, {}, (b) => obj(b).environments);
      const environments: Environments['environments'] = [];
      const branchPolicies = async (name: string) => {
        const found = await envPolicies(gh, base, name);
        if (found.tags > 0) {
          collector.warn('environments.tag-policy-skipped', [], { name, count: found.tags });
        }
        return found.branches.sort();
      };
      for (const e of list) {
        const name = str(e.name);
        if (name === '') continue;
        const policy = obj(e.deployment_branch_policy);
        const custom = policy.custom_branch_policies === true;
        environments.push({
          name,
          // GitHub has no environment category (FAC-ENV).
          category: null,
          deploymentBranches: custom ? await branchPolicies(name) : null,
        });
      }
      return collector.result({ environments: sortBy(environments, (e) => e.name) });
    },
    async *apply(ctx, target, desired, current) {
      const repo = repoTarget(target);
      const gh = ghOf(ctx);
      const base = repoPath(deps.org, repo.slug);
      const have = new Map(
        (current ?? (await this.read(ctx, target)).data).environments.map((e) => [
          e.name.toLowerCase(),
          e,
        ]),
      );
      for (const env of sortBy(desired.environments, (e) => e.name)) {
        const existing = have.get(env.name.toLowerCase());
        const wantedBranches =
          env.deploymentBranches === null ? null : [...env.deploymentBranches].sort();
        // Satisfied when every wanted branch policy exists; extra target policies are left alone.
        const haveBranches = existing?.deploymentBranches ?? null;
        const satisfied =
          wantedBranches === null
            ? haveBranches === null
            : haveBranches !== null && wantedBranches.every((b) => haveBranches.includes(b));
        if (existing && satisfied) {
          // Subset rule: extra target policies are never deleted. Say so, so an operator can see them.
          const extra =
            wantedBranches !== null && haveBranches !== null
              ? haveBranches.filter((b) => !wantedBranches.includes(b))
              : [];
          if (extra.length > 0) {
            ctx.logger.warn(
              {
                repository: repo.slug,
                environment: env.name,
                extraPolicies: extra,
              },
              'environment keeps deployment branch policies the source does not have; they are not removed',
            );
          }
          continue;
        }
        // What the environment really had, to put back exactly (`protected_branches`, custom or
        // all branches); the canonical `deploymentBranches` cannot tell the first from the last.
        const rawEnvs = existing
          ? await gh.list<Json>(`${base}/environments`, {}, (b) => obj(b).environments)
          : [];
        const rawPolicy =
          rawEnvs.find((e) => str(e.name).toLowerCase() === env.name.toLowerCase())
            ?.deployment_branch_policy ?? null;
        const haveNames = new Set(existing?.deploymentBranches ?? []);
        const addedBranches = (wantedBranches ?? []).filter((b) => !haveNames.has(b));
        // No reviewers or wait timers: not available on private Team repositories (provider doc).
        await gh.send('PUT', `${base}/environments/${encodeURIComponent(env.name)}`, {
          deployment_branch_policy:
            wantedBranches === null
              ? null
              : { protected_branches: false, custom_branch_policies: true },
        });
        // Recorded right after the PUT that changed the target: a failing policy POST below then
        // leaves a ledgered create (or update), so a retry and an undo both see the environment.
        yield mutation(
          'environments',
          existing ? 'update' : 'create',
          { kind: 'environment', repository: repo.slug, name: env.name },
          [itemPath('environments', 'name', env.name)],
          existing ? { ...existing, deploymentBranchPolicy: rawPolicy } : null,
          { ...env, category: null, deploymentBranches: wantedBranches, addedBranches },
        );
        if (wantedBranches !== null) {
          for (const name of addedBranches) {
            await gh.send(
              'POST',
              `${base}/environments/${encodeURIComponent(env.name)}/deployment-branch-policies`,
              { name, type: 'branch' },
            );
          }
        }
      }
    },
    async undo(ctx, target, record) {
      const repo = repoTarget(target);
      if (record.resourceRef.kind !== 'environment' || record.action === 'delete') {
        throw cannotUndo(record);
      }
      const gh = ghOf(ctx);
      const base = repoPath(deps.org, repo.slug);
      const url = `${base}/environments/${encodeURIComponent(String(record.resourceRef.name))}`;
      if (record.action === 'create') {
        await ignoreGone(gh.send('DELETE', url));
        return;
      }
      // An update: back to the policy the environment had, exactly as the provider reported it,
      // and only the branch policies this apply added are removed. An environment that is gone is
      // not created again by an undo.
      if ((await gh.getOrNull(url)) === null) return;
      const before = obj(record.before);
      const was =
        'deploymentBranchPolicy' in before
          ? before.deploymentBranchPolicy
          : Array.isArray(before.deploymentBranches)
            ? { protected_branches: false, custom_branch_policies: true }
            : null;
      await gh.send('PUT', url, { deployment_branch_policy: was ?? null });
      const added = obj(record.after).addedBranches;
      if (!Array.isArray(added) || added.length === 0) return;
      const mine = new Set(added.map(String));
      const policies = await gh.list<Json>(
        `${url}/deployment-branch-policies`,
        {},
        (b) => obj(b).branch_policies,
      );
      for (const policy of policies) {
        if (mine.has(str(policy.name)) && policy.type !== 'tag') {
          await ignoreGone(gh.send('DELETE', `${url}/deployment-branch-policies/${policy.id}`));
        }
      }
    },
  };
}

// -- variables and secrets ----------------------------------------------------------------------

const VARIABLE_PAGE = 30;

async function scopes(gh: Gh, base: string): Promise<{ scope: string; path: string }[]> {
  const envs = await gh.list<Json>(`${base}/environments`, {}, (b) => obj(b).environments);
  return [
    { scope: 'repository', path: `${base}/actions` },
    ...envs.flatMap((e) =>
      str(e.name) === ''
        ? []
        : [
            {
              scope: `environment:${str(e.name)}`,
              path: `${base}/environments/${encodeURIComponent(str(e.name))}`,
            },
          ],
    ),
  ];
}

export function variablesDriver(deps: DriverDeps): FacetDriver<Variables> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const gh = ghOf(ctx, collector);
      const variables: Variables['variables'] = [];
      for (const s of await scopes(gh, repoPath(deps.org, repo.slug))) {
        const list = await gh.list<Json>(
          `${s.path}/variables`,
          {},
          (b) => obj(b).variables,
          VARIABLE_PAGE,
        );
        for (const v of list) {
          const name = str(v.name);
          if (name === '' || name.includes('/')) continue;
          variables.push({
            key: scopedKey(s.scope, name),
            scope: s.scope,
            name,
            value: str(v.value),
          });
        }
      }
      return collector.result({ variables: sortBy(variables, (v) => v.key) });
    },
    async *apply(ctx, target, desired, current) {
      const repo = repoTarget(target);
      const gh = ghOf(ctx);
      const base = repoPath(deps.org, repo.slug);
      const have = new Map(
        (current ?? (await this.read(ctx, target)).data).variables.map((v) => [
          v.key.toLowerCase(),
          v,
        ]),
      );
      const paths = new Map((await scopes(gh, base)).map((s) => [s.scope, s.path]));
      for (const v of sortBy(desired.variables, (x) => x.key)) {
        const existing = have.get(v.key.toLowerCase());
        if (existing?.value === v.value) continue;
        const path = paths.get(v.scope);
        if (!path) {
          ctx.logger.warn({ scope: v.scope }, 'environment missing; variable skipped');
          continue;
        }
        if (existing)
          await gh.send('PATCH', `${path}/variables/${encodeURIComponent(v.name)}`, {
            name: v.name,
            value: v.value,
          });
        else await gh.send('POST', `${path}/variables`, { name: v.name, value: v.value });
        yield mutation(
          'variables',
          existing ? 'update' : 'create',
          { kind: 'variable', repository: repo.slug, scope: v.scope, name: v.name },
          [itemPath('variables', 'key', v.key)],
          existing ?? null,
          v,
        );
      }
    },
    async undo(ctx, target, record) {
      const repo = repoTarget(target);
      const ref = record.resourceRef;
      if (ref.kind !== 'variable' || record.action === 'delete') throw cannotUndo(record);
      const gh = ghOf(ctx);
      const path = (await scopes(gh, repoPath(deps.org, repo.slug))).find(
        (s) => s.scope === ref.scope,
      )?.path;
      // The environment of a scoped variable is gone: so is the variable.
      if (path === undefined) return;
      const name = encodeURIComponent(String(ref.name));
      if (record.action === 'create') {
        await ignoreGone(gh.send('DELETE', `${path}/variables/${name}`));
        return;
      }
      await ignoreGone(
        gh.send('PATCH', `${path}/variables/${name}`, {
          name: String(ref.name),
          value: str(obj(record.before).value),
        }),
      );
    },
  };
}

/** Secret names only; values are never read and never written (FAC-SEC-001). */
export function secretsDriver(deps: DriverDeps): FacetDriver<Secrets> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const gh = ghOf(ctx, collector);
      const secrets: Secrets['secrets'] = [];
      for (const s of await scopes(gh, repoPath(deps.org, repo.slug))) {
        const list = await gh.list<Json>(`${s.path}/secrets`, {}, (b) => obj(b).secrets);
        for (const x of list) {
          const name = str(x.name);
          if (name === '' || name.includes('/')) continue;
          secrets.push({ key: scopedKey(s.scope, name), scope: s.scope, name });
        }
      }
      return collector.result({ secrets: sortBy(secrets, (v) => v.key) });
    },
  };
}

// -- org-variables and org-secrets --------------------------------------------------------------

export function orgVariablesDriver(deps: DriverDeps): FacetDriver<OrgVariables> {
  return {
    async read(ctx, target) {
      const collector = new Collector();
      const list = await ghOf(ctx, collector).list<Json>(
        `/orgs/${orgTarget(target)}/actions/variables`,
        {},
        (b) => obj(b).variables,
        VARIABLE_PAGE,
      );
      const variables: OrgVariables['variables'] = [];
      for (const v of list) {
        if (v.visibility !== 'all') {
          collector.warn('org-variables.visibility-unrepresentable', [], { name: str(v.name) });
          continue;
        }
        variables.push({ name: str(v.name), value: str(v.value), visibility: 'all' });
      }
      return collector.result({ variables: sortBy(variables, (v) => v.name) });
    },
    async *apply(ctx, target, desired, current) {
      const gh = ghOf(ctx);
      const org = orgTarget(target);
      const have = new Map(
        (current ?? (await this.read(ctx, target)).data).variables.map((v) => [
          v.name.toLowerCase(),
          v,
        ]),
      );
      void deps;
      for (const v of sortBy(desired.variables, (x) => x.name)) {
        const existing = have.get(v.name.toLowerCase());
        if (existing?.value === v.value) continue;
        if (existing) {
          await gh.send('PATCH', `/orgs/${org}/actions/variables/${encodeURIComponent(v.name)}`, {
            name: v.name,
            value: v.value,
            visibility: 'all',
          });
        } else {
          await gh.send('POST', `/orgs/${org}/actions/variables`, {
            name: v.name,
            value: v.value,
            visibility: 'all',
          });
        }
        yield mutation(
          'org-variables',
          existing ? 'update' : 'create',
          { kind: 'org-variable', name: v.name },
          [itemPath('variables', 'name', v.name)],
          existing ?? null,
          v,
        );
      }
    },
    async undo(ctx, target, record) {
      if (record.resourceRef.kind !== 'org-variable' || record.action === 'delete') {
        throw cannotUndo(record);
      }
      const gh = ghOf(ctx);
      const url = `/orgs/${orgTarget(target)}/actions/variables/${encodeURIComponent(String(record.resourceRef.name))}`;
      if (record.action === 'create') {
        await ignoreGone(gh.send('DELETE', url));
        return;
      }
      await ignoreGone(
        gh.send('PATCH', url, {
          name: String(record.resourceRef.name),
          value: str(obj(record.before).value),
          visibility: 'all',
        }),
      );
    },
  };
}

export function orgSecretsDriver(_deps: DriverDeps): FacetDriver<OrgSecrets> {
  return {
    async read(ctx, target) {
      const collector = new Collector();
      const list = await ghOf(ctx, collector).list<Json>(
        `/orgs/${orgTarget(target)}/actions/secrets`,
        {},
        (b) => obj(b).secrets,
      );
      return collector.result({
        secrets: sortBy(
          list.flatMap((s) => (str(s.name) === '' ? [] : [{ name: str(s.name) }])),
          (s) => s.name,
        ),
      });
    },
  };
}
