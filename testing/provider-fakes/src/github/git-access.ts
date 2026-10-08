import type { AuthCtx } from './auth.ts';
import { repoVisibleTo } from './router.ts';
import { checkRefUpdate, refUpdateKind } from './rules.ts';
import { GitHubState } from './state.ts';

/**
 * Ties the git server's `target` side (T-040) to the fake GitHub: credentials are installation
 * tokens (Basic, any username, token as password), access follows the token's repository restriction
 * and Contents permission, and pushes go through the branch protection rules (ADR-0040, ADR-0076).
 * `getState` is late-bound because the git server starts before the fake GitHub.
 */
export function githubGitAccess(getState: () => GitHubState | undefined) {
  const tokenCtx = (password: string): { state: GitHubState; auth: AuthCtx } | undefined => {
    const state = getState();
    const token = state?.tokens.get(password);
    if (!state || !token || token.expiresAt <= state.clock()) return undefined;
    const installation = state.installations.get(token.installationId);
    if (!installation || installation.suspended) return undefined;
    const app = state.apps.get(installation.appId);
    return {
      state,
      auth: {
        kind: 'installation',
        app,
        installation,
        token,
        permissions: token.permissions,
        rateKey: `inst:${installation.id}`,
        actor: app?.slug ?? 'app',
      },
    };
  };
  const repoOf = (state: GitHubState, auth: AuthCtx, path: string) => {
    const [owner, name, ...extra] = path.split('/');
    if (!owner || !name || extra.length) return undefined;
    const repo = state.findRepo(owner, name);
    return repo && repoVisibleTo(auth, repo) ? repo : undefined;
  };
  return {
    authenticate: (_username: string, password: string): boolean =>
      tokenCtx(password) !== undefined,
    authorize: ({
      password,
      repo,
      operation,
    }: {
      password: string;
      repo: string;
      operation: 'read' | 'write';
    }): number | undefined => {
      const ctx = tokenCtx(password);
      if (!ctx) return 403;
      if (!repoOf(ctx.state, ctx.auth, repo)) return 404;
      return GitHubState.allows(
        ctx.auth.permissions,
        'contents',
        operation === 'write' ? 'write' : 'read',
      )
        ? undefined
        : 403;
    },
    refPolicyFlag: true,
    refPolicy: (u: {
      password: string;
      repo: string;
      ref: string;
      old: string;
      new: string;
      fastForward: boolean;
    }): string | undefined => {
      const ctx = tokenCtx(u.password);
      const repo = ctx && repoOf(ctx.state, ctx.auth, u.repo);
      if (!ctx || !repo) return 'repository not found';
      if (u.ref.startsWith('refs/pull/')) return `deny updating a hidden ref: ${u.ref}`;
      return checkRefUpdate(repo, u.ref, refUpdateKind(u.old, u.new, u.fastForward), {
        nodeIds: ctx.auth.app ? [ctx.auth.app.nodeId] : [],
        isAdmin: GitHubState.allows(ctx.auth.permissions, 'administration', 'write'),
      });
    },
  };
}
