/** git-refs (FAC-GIT), repository-settings (FAC-SET) and merge-settings (FAC-MRG) drivers. */
import type { FacetDriver, MutationRecord } from '@git-migrator/adapter-sdk';
import type {
  GitRefs,
  MergeSettings,
  MergeStrategy,
  RepositorySettings,
} from '@git-migrator/canonical';
import { Collector, type Json, obj, repoPath, str } from '../gh.ts';
import { type DriverDeps, fieldPath, ghOf, mutation, repoTarget, sortBy } from './common.ts';

// -- git-refs (read only: refs are written by git push) -----------------------------------------

export function gitRefsDriver(deps: DriverDeps): FacetDriver<GitRefs> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const credential = await deps.access.credential(repo);
      const result = await ctx.git.lsRemote({
        url: deps.access.remoteUrl(repo),
        credential,
        signal: ctx.signal,
      });
      const refs: GitRefs['refs'] = [];
      const ignored: string[] = [];
      for (const ref of result.refs) {
        if (ref.name === 'HEAD') continue;
        const kind = ref.name.startsWith('refs/heads/')
          ? 'branch'
          : ref.name.startsWith('refs/tags/')
            ? 'tag'
            : undefined;
        if (kind === undefined) ignored.push(ref.name);
        else {
          refs.push({
            name: ref.name,
            kind,
            target: ref.sha,
            ...(ref.peeled !== undefined && ref.peeled !== ref.sha ? { peeled: ref.peeled } : {}),
          });
        }
      }
      const head = result.headSymref;
      return collector.result<GitRefs>({
        defaultBranch: head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : null,
        refs: sortBy(refs, (r) => r.name),
        ignoredRefs: ignored.sort(),
        lfs: {},
      });
    },
  };
}

// -- repository-settings ------------------------------------------------------------------------

function settingsOf(repo: Json, privateForkingAllowed: boolean): RepositorySettings {
  const isPrivate = repo.private === true;
  let forking: RepositorySettings['forking'] = 'allowed';
  if (isPrivate && repo.allow_forking === false && privateForkingAllowed) forking = 'disallowed';
  return {
    description: str(repo.description),
    homepage: str(repo.homepage) === '' ? null : str(repo.homepage),
    visibility: isPrivate ? 'private' : 'public',
    features: { issues: repo.has_issues !== false, wiki: repo.has_wiki === true },
    forking,
  };
}

export function repositorySettingsDriver(deps: DriverDeps): FacetDriver<RepositorySettings> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const gh = ghOf(ctx, collector);
      const [repoBody, org] = await Promise.all([
        gh.get(repoPath(deps.org, repo.slug)),
        gh.get(`/orgs/${deps.org}`),
      ]);
      // FAC-SET-002: private forking can be forbidden organization-wide.
      const forkable = obj(org).members_can_fork_private_repositories !== false;
      if (!forkable) {
        collector.capabilities['/forking'] = {
          kind: 'unsupported',
          note: 'organization does not allow forking of private repositories',
        };
      }
      return collector.result(settingsOf(repoBody, forkable));
    },
    async *apply(ctx, target, desired, current) {
      const repo = repoTarget(target);
      const gh = ghOf(ctx);
      const read = current ?? (await this.read(ctx, target)).data;
      const patch: Json = {};
      const paths: string[] = [];
      const before: Json = {};
      const after: Json = {};
      const set = (path: string, key: string, from: unknown, to: unknown, field: string) => {
        patch[key] = to;
        paths.push(path);
        before[field] = from;
        after[field] = to;
      };
      if (desired.description !== read.description) {
        set('/description', 'description', read.description, desired.description, 'description');
      }
      if (desired.homepage !== read.homepage) {
        set('/homepage', 'homepage', read.homepage, desired.homepage ?? '', 'homepage');
      }
      if (desired.visibility !== read.visibility) {
        set(
          '/visibility',
          'private',
          read.visibility,
          desired.visibility === 'private',
          'visibility',
        );
        after.visibility = desired.visibility;
      }
      if (desired.features.issues !== read.features.issues) {
        set(
          '/features/issues',
          'has_issues',
          read.features.issues,
          desired.features.issues,
          'issues',
        );
      }
      if (desired.features.wiki !== read.features.wiki) {
        set('/features/wiki', 'has_wiki', read.features.wiki, desired.features.wiki, 'wiki');
      }
      const allowFork = desired.forking !== 'disallowed';
      const readFork = read.forking !== 'disallowed';
      if (desired.visibility === 'private' && allowFork !== readFork) {
        const org = await gh.get(`/orgs/${deps.org}`);
        if (obj(org).members_can_fork_private_repositories !== false) {
          set('/forking', 'allow_forking', read.forking, allowFork, 'forking');
          after.forking = desired.forking;
        }
      }
      if (paths.length === 0) return;
      await gh.send('PATCH', repoPath(deps.org, repo.slug), patch);
      yield mutation(
        'repository-settings',
        'update',
        { kind: 'repository', repository: repo.slug },
        paths,
        before,
        after,
      );
    },
  };
}

// -- merge-settings -----------------------------------------------------------------------------

function mergeOf(repo: Json): MergeSettings {
  const allowed: MergeStrategy[] = [];
  if (repo.allow_merge_commit !== false) allowed.push('merge-commit');
  if (repo.allow_rebase_merge !== false) allowed.push('rebase');
  if (repo.allow_squash_merge !== false) allowed.push('squash');
  return { allowed: allowed.sort(), deleteBranchOnMerge: repo.delete_branch_on_merge === true };
}

export function mergeSettingsDriver(deps: DriverDeps): FacetDriver<MergeSettings> {
  return {
    async read(ctx, target) {
      const repo = repoTarget(target);
      const collector = new Collector();
      const body = await ghOf(ctx, collector).get(repoPath(deps.org, repo.slug));
      return collector.result(mergeOf(body));
    },
    async *apply(ctx, target, desired, current) {
      const repo = repoTarget(target);
      const read = current ?? (await this.read(ctx, target)).data;
      // `fast-forward-only` has no equivalent; the facet maps it to `rebase` (FAC-MRG-001).
      const wanted = new Set<MergeStrategy>(desired.allowed);
      const have = new Set<MergeStrategy>(read.allowed);
      const patch: Json = {};
      const paths: string[] = [];
      const flags: [MergeStrategy, string][] = [
        ['merge-commit', 'allow_merge_commit'],
        ['squash', 'allow_squash_merge'],
        ['rebase', 'allow_rebase_merge'],
      ];
      // GitHub refuses a repository with no merge method at all; keep what is there.
      const representable = flags.some(([strategy]) => wanted.has(strategy));
      if (!representable) {
        ctx.logger.warn(
          { finding: 'merge-settings.no-representable-strategy' },
          'no merge strategy GitHub can represent; allowed strategies left unchanged',
        );
      }
      for (const [strategy, key] of flags) {
        if (representable && wanted.has(strategy) !== have.has(strategy)) {
          patch[key] = wanted.has(strategy);
          paths.push(fieldPath('allowed'));
        }
      }
      if (desired.deleteBranchOnMerge !== read.deleteBranchOnMerge) {
        patch.delete_branch_on_merge = desired.deleteBranchOnMerge;
        paths.push('/deleteBranchOnMerge');
      }
      if (Object.keys(patch).length === 0) return;
      await ghOf(ctx).send('PATCH', repoPath(deps.org, repo.slug), patch);
      const record: MutationRecord = mutation(
        'merge-settings',
        'update',
        { kind: 'repository', repository: repo.slug },
        [...new Set(paths)],
        read,
        { allowed: [...wanted].sort(), deleteBranchOnMerge: desired.deleteBranchOnMerge },
      );
      yield record;
    },
  };
}
