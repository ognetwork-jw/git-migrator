import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type bitbucket,
  createBareRepo,
  type FakeGitServer,
  type github,
  type SeedResult,
  type SeedSpec,
  seedBareRepo,
} from '@git-migrator/provider-fakes';
import {
  type ProjectKey,
  WORLD_GITHUB_ONLY_MEMBERS,
  WORLD_GROUPS,
  WORLD_LIMITS,
  WORLD_MEMBERS,
  WORLD_ORG,
  WORLD_PROJECTS,
  WORLD_REPOSITORIES,
  WORLD_WORKSPACE,
  type WorldRepository,
} from './world-spec.ts';

type BitbucketState = bitbucket.BitbucketState;
type GitHubState = github.GitHubState;

/**
 * Merge strategies of every world branch. The Bitbucket default also offers `fast_forward`, whose
 * mapping to a `merge-settings` lossy decision the spec leaves open (ADR-0130), so the world offers
 * only the two that map exactly and every repository can be Ready.
 */
const MERGE_STRATEGIES: bitbucket.MergeStrategy[] = ['merge_commit', 'squash'];

const MIB = 1024 * 1024;

const PIPELINES_SIMPLE = `image: node:20
pipelines:
  default:
    - step:
        name: Build and test
        max-time: 10
        caches:
          - node
        script:
          - npm ci
          - npm test
  branches:
    main:
      - step:
          name: Package
          script:
            - npm run build
`;

const PIPELINES_PIPES = `image: node:20
pipelines:
  default:
    - step:
        name: Scan
        script:
          - pipe: atlassian/git-secrets-scan:0.5.1
    - step:
        name: Release
        trigger: manual
        script:
          - ./release.sh
`;

/**
 * A syntactically valid ed25519 public key derived from a label. There is no private key behind it,
 * and it is not a secret.
 */
export function fakePublicKey(label: string): string {
  const type = Buffer.from('ssh-ed25519');
  const length = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const key = createHash('sha256').update(`git-migrator fixture key ${label}`).digest();
  const blob = Buffer.concat([length(type.length), type, length(key.length), key]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

/** What each repository is seeded with in the git server. */
export function seedSpecFor(key: string): SeedSpec {
  switch (key) {
    case 'plat/auto-ok':
      return {
        commits: 3,
        branches: [{ name: 'develop' }, { name: 'feature/one' }],
        tags: [
          { name: 'v1.0.0', annotated: true },
          { name: 'v1.0.1', annotated: false },
        ],
        lfsFiles: [{ path: 'assets/sample.bin', bytes: 1_000_000 }],
      };
    case 'plat/open-pr':
      return { commits: 2, branches: [{ name: 'feature/x' }] };
    case 'data/with-grants':
      return { commits: 2, branches: [{ name: 'develop' }] };
    case 'data/pipelines-simple':
      return {
        commits: 2,
        bigBlobs: [{ path: 'bitbucket-pipelines.yml', content: PIPELINES_SIMPLE }],
      };
    case 'data/pipelines-pipes':
      return {
        commits: 2,
        bigBlobs: [{ path: 'bitbucket-pipelines.yml', content: PIPELINES_PIPES }],
      };
    case 'ops/big-blob':
      return { commits: 2, bigBlobs: [{ path: 'data/dump.bin', bytes: 2 * MIB }] };
    case 'ops/large-history':
      return { commits: 64, bytesPerCommit: 64 * 1024 };
    default:
      return { commits: 2 };
  }
}

/** The wiki repository of `ops/wiki-issues` (FAC-EXT): a bare repository inside the repository's. */
const WIKI_SEED: SeedSpec = { commits: 1 };

export interface SeededWorld {
  /** Seed result by repository key (`plat/auto-ok`). Empty without a git server. */
  seeds: Map<string, SeedResult>;
}

const bare = (git: FakeGitServer, slug: string) =>
  git.repoDir('source', `${WORLD_WORKSPACE}/${slug}`);

/** Removes every world repository from the git `source` side, with its LFS objects. */
export async function cleanSourceGit(git: FakeGitServer): Promise<void> {
  await rm(dirname(bare(git, '_')), { recursive: true, force: true });
  await rm(join(git.lfsStore('source').dir, WORLD_WORKSPACE), { recursive: true, force: true });
}

/**
 * Rebuilds the `source` side of the git server: removes every repository of the workspace (and its
 * LFS objects), then creates and seeds the world's repositories. Deterministic: two runs give the
 * same commit ids.
 */
export async function seedSourceGit(git: FakeGitServer): Promise<SeededWorld> {
  await cleanSourceGit(git);
  const seeds = new Map<string, SeedResult>();
  for (const repo of WORLD_REPOSITORIES) {
    const path = bare(git, repo.slug);
    await createBareRepo(path);
    seeds.set(
      repo.key,
      await seedBareRepo(path, seedSpecFor(repo.key), {
        store: git.lfsStore('source'),
        repo: `${WORLD_WORKSPACE}/${repo.slug}`,
      }),
    );
  }
  const wiki = join(bare(git, 'wiki-issues'), 'wiki');
  await createBareRepo(wiki);
  await seedBareRepo(wiki, WIKI_SEED);
  return { seeds };
}

const ws = WORLD_WORKSPACE;

/** The fake serves `src` from memory (ref independent), so the file is stored there as well. */
function enablePipelines(state: BitbucketState, slug: string, yaml: string): void {
  const repo = state.repository(ws, slug);
  if (!repo) throw new Error(`unknown repository ${slug}`);
  repo.pipelinesEnabled = true;
  repo.files['bitbucket-pipelines.yml'] = yaml;
}

type Configure = (state: BitbucketState, slug: string) => void;

/** Bitbucket-side settings beyond the git data, per repository. */
const CONFIGURE: Record<string, Configure> = {
  'plat/auto-ok': (s, slug) => {
    s.addBranchRestriction(ws, slug, { kind: 'force', pattern: 'main' });
    s.addBranchRestriction(ws, slug, { kind: 'delete', pattern: 'main' });
    s.addDeployKey(ws, slug, { key: fakePublicKey('auto-ok'), label: 'e2e-key' });
    s.addVariable(ws, slug, { key: 'E2E_VAR', value: 'hello' });
    s.addVariable(ws, slug, { key: 'RELEASE_CHANNEL', value: 'stable' });
    s.addEnvironment(ws, slug, { name: 'production', environmentType: 'Production' });
  },
  'data/with-grants': (s, slug) => {
    s.grantRepositoryUser(ws, slug, 'acct-alice', 'write');
    s.grantRepositoryUser(ws, slug, 'acct-bob', 'read');
    s.grantRepositoryGroup(ws, slug, 'platform-team', 'write');
    s.addBranchRestriction(ws, slug, { kind: 'push', pattern: 'main', groups: ['platform-team'] });
  },
  'plat/with-secrets': (s, slug) => {
    s.addVariable(ws, slug, { key: 'REGION', value: 'eu-west-1' });
    s.addVariable(ws, slug, { key: 'API_TOKEN', secured: true });
  },
  'plat/open-pr': (s, slug) => {
    s.addPullRequest(ws, slug, {
      title: 'Add feature x',
      authorAccountId: 'acct-alice',
      sourceBranch: 'feature/x',
    });
  },
  'data/unmapped-user': (s, slug) => {
    s.grantRepositoryUser(ws, slug, 'acct-carol', 'write');
  },
  'data/pipelines-simple': (s, slug) => {
    enablePipelines(s, slug, PIPELINES_SIMPLE);
  },
  'data/pipelines-pipes': (s, slug) => {
    enablePipelines(s, slug, PIPELINES_PIPES);
  },
  'ops/hooks': (s, slug) => {
    s.addWebhook(ws, slug, {
      url: 'https://hooks.acme.example/ci',
      description: 'CI (allowlisted)',
      events: ['repo:push', 'pullrequest:created'],
    });
    s.addWebhook(ws, slug, {
      url: 'https://thirdparty.example/hooks/bitbucket',
      description: 'Third party (not allowlisted)',
      events: ['repo:push'],
      secretSet: true,
    });
  },
  'ops/wiki-issues': (s, slug) => {
    const repo = s.repository(ws, slug);
    if (!repo) return;
    repo.hasIssues = true;
    repo.hasWiki = true;
    repo.issueCount = 3;
    repo.downloadCount = 2;
  },
};

function applyShared(state: BitbucketState): void {
  const key = fakePublicKey('shared-project-key');
  state.addProjectDeployKey(ws, 'KEYS', { key, label: 'shared project key' });
}

/**
 * Builds the Bitbucket side of the world into freshly reset state (the `world` fixture of the fake
 * Bitbucket). With `seeds`, branches carry the real commit ids and `gitRoot` points at the bare
 * repository; without them the fake's deterministic hashes are used.
 */
export function buildBitbucketWorld(
  state: BitbucketState,
  options: { git?: FakeGitServer; seeds?: Map<string, SeedResult> } = {},
): void {
  state.addWorkspace({ slug: ws, name: 'Acme' });
  state.addCredentialMembers(ws, { admin: true });
  for (const m of WORLD_MEMBERS) {
    state.addUser({
      nickname: m.nickname,
      accountId: m.accountId,
      ...(m.email ? { email: m.email } : {}),
    });
    state.addMember(ws, m.accountId);
  }
  for (const g of WORLD_GROUPS) {
    // `none`: no group grants default access to a repository (e2e-setup, "Permissions").
    state.addGroup(ws, { ...g, defaultPermission: 'none' });
  }
  for (const p of WORLD_PROJECTS) state.addProject(ws, p);

  for (const repo of WORLD_REPOSITORIES) {
    const seed = options.seeds?.get(repo.key);
    const spec = seedSpecFor(repo.key);
    const branchNames = ['main', ...(spec.branches ?? []).map((b) => b.name)];
    state.addRepository(ws, {
      slug: repo.slug,
      projectKey: repo.project,
      description: repo.key === 'plat/auto-ok' ? 'git-migrator e2e fixture' : repo.summary,
      gitRoot: options.git ? bare(options.git, repo.slug) : null,
      branches: branchNames.map((name) =>
        state.makeBranch(ws, repo.slug, name, {
          mergeStrategies: MERGE_STRATEGIES,
          defaultMergeStrategy: 'merge_commit',
          ...(seed?.heads[name] ? { hash: seed.heads[name] } : {}),
        }),
      ),
    });
    CONFIGURE[repo.key]?.(state, repo.slug);
  }
  applyShared(state);
}

/**
 * Builds the GitHub side: the organization with the members that match some Bitbucket members by
 * email and by login, no teams, no repositories (TST-012), and the target limits that make the
 * big-blob and large-history repositories behave as specified. Sets the limits on the fake's REST
 * contents API and on the git server `target` side.
 */
export function buildGitHubWorld(state: GitHubState, git?: FakeGitServer): void {
  state.addOrg({ login: WORLD_ORG });
  for (const m of WORLD_MEMBERS) {
    if (!m.github) continue;
    state.addUser({
      login: m.github.login,
      ...(m.github.email ? { email: m.github.email } : {}),
      ...(m.github.publicEmail ? { publicEmail: m.github.publicEmail } : {}),
    });
    state.addMember(WORLD_ORG, m.github.login);
  }
  for (const m of WORLD_GITHUB_ONLY_MEMBERS) {
    state.addUser({ login: m.login, email: m.email, publicEmail: m.email });
    state.addMember(WORLD_ORG, m.login);
  }
  state.config.maxBlobBytes = WORLD_LIMITS.maxBlobBytes;
  git?.setLimits('target', WORLD_LIMITS);
}

export interface WorldFixtures {
  bitbucket: Record<string, bitbucket.FixtureBuilder>;
  github: Record<string, (state: GitHubState) => void | Promise<void>>;
}

/**
 * The `world` fixture for both fakes (TST-012), ready for `createFakeBitbucket({ fixtures })` and
 * `createFakeGitHub({ fixtures })`. `getGit` is late-bound because the git server starts before the
 * fakes but after their options are written. Without a git server only the REST state is built.
 */
export function worldFixtures(
  getGit: () => FakeGitServer | undefined = () => undefined,
): WorldFixtures {
  return {
    bitbucket: {
      world: async (state) => {
        const git = getGit();
        const seeded = git ? await seedSourceGit(git) : undefined;
        buildBitbucketWorld(state, { git, seeds: seeded?.seeds });
      },
    },
    github: {
      world: (state) => buildGitHubWorld(state, getGit()),
    },
  };
}

export type { ProjectKey, WorldRepository };
