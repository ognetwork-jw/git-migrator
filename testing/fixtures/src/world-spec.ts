/**
 * The TST-012 fixture world as plain data: identities, repositories, seeds and the expected
 * readiness and findings of each repository. No I/O and no provider fake imports, so a facet or
 * integration test can import the expectations without starting anything.
 *
 * Expectations are derived from the spec text (05-facets, 06-migration-lifecycle LIF-004/LIF-031,
 * 08-identity-and-auth AUTH-050), not from running the facets: they are not built yet (see the
 * README table, column "Basis").
 */

export type ProjectKey = 'PLAT' | 'DATA' | 'OPS' | 'KEYS';
export type Readiness = 'ready' | 'needs_attention' | 'blocked';
/** Notation of docs/spec/05-facets.md: B, pre, post, W. */
export type FindingSeverity = 'blocker' | 'pre' | 'post' | 'warning';

export interface ExpectedFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  /** Why the finding is expected, in spec terms. */
  readonly why: string;
}

export interface ExpectedOutcome {
  readonly readiness: Readiness;
  readonly findings: readonly ExpectedFinding[];
}

/** A later state of the same repository, after something the scenario does. */
export interface ExpectedStage extends ExpectedOutcome {
  readonly after: string;
}

export interface WorldRepository {
  readonly project: ProjectKey;
  readonly slug: string;
  /** `{project lowercase}/{slug}`, as TST-012 names it. */
  readonly key: string;
  /** Target name under the default naming pipeline (LIF-030), before collision handling. */
  readonly plannedTargetName: string;
  /** Expected result of the first Analysis, with the default Route configuration (`WORLD_ROUTE`). */
  readonly analysis: ExpectedOutcome;
  /** Later states, in order. */
  readonly stages?: readonly ExpectedStage[];
  /** Short description of what makes the repository interesting. */
  readonly summary: string;
  /** Scenario that exercises it. */
  readonly coveredBy: string;
}

/** Route configuration the expectations assume. */
export const WORLD_ROUTE = {
  /** FAC-005 defaults. */
  acceptLossy: ['branch-rules.advisory-enforced', 'environments.category-dropped'],
  /** FAC-WEB-002: URLs matching these globs are auto-created on the target. */
  webhookAllowlist: ['https://hooks.acme.example/**'],
  autoConfirmEmail: true,
} as const;

/** The limits the world sets on the fake GitHub and the git server `target` side. */
export const WORLD_LIMITS = {
  /** `ops/big-blob` holds a 2 MiB blob. */
  maxBlobBytes: 1024 * 1024,
  /** `ops/large-history` is about 4 MiB of history. */
  maxPushBytes: 1024 * 1024,
} as const;

export const WORLD_WORKSPACE = 'acme';
export const WORLD_ORG = 'acme';

export const WORLD_PROJECTS: readonly { key: ProjectKey; name: string }[] = [
  { key: 'PLAT', name: 'Platform' },
  { key: 'DATA', name: 'Data' },
  { key: 'OPS', name: 'Operations' },
  { key: 'KEYS', name: 'Keys' },
];

export interface WorldMember {
  /** Bitbucket nickname. */
  nickname: string;
  /** Bitbucket account id. */
  accountId: string;
  /** Bitbucket-side email (visible only through Atlassian Admin enrichment, AUTH-050). */
  email?: string;
  /** GitHub login of the org member this person matches, if any. */
  github?: { login: string; email?: string; publicEmail?: string };
  /** Expected AUTH-050 outcome after an inventory. */
  match: 'email' | 'login' | 'none';
}

/**
 * Workspace members. The credential account `operator@test.local` is an additional workspace admin.
 * `alice` matches by email (different logins), `bob` by login only (suggested), `carol` not at all.
 * `erin` exists only on GitHub.
 */
export const WORLD_MEMBERS: readonly WorldMember[] = [
  {
    nickname: 'alice',
    accountId: 'acct-alice',
    email: 'alice@acme.example',
    github: { login: 'alice-gh', email: 'alice@acme.example', publicEmail: 'alice@acme.example' },
    match: 'email',
  },
  {
    nickname: 'bob',
    accountId: 'acct-bob',
    github: { login: 'bob' },
    match: 'login',
  },
  {
    nickname: 'carol',
    accountId: 'acct-carol',
    email: 'carol@acme.example',
    match: 'none',
  },
];

/** GitHub-only members (no Bitbucket counterpart). */
export const WORLD_GITHUB_ONLY_MEMBERS: readonly { login: string; email: string }[] = [
  { login: 'erin', email: 'erin@acme.example' },
];

export const WORLD_GROUPS: readonly { slug: string; name: string; members: string[] }[] = [
  { slug: 'platform-team', name: 'Platform Team', members: ['acct-alice', 'acct-bob'] },
];

const f = (code: string, severity: FindingSeverity, why: string): ExpectedFinding => ({
  code,
  severity,
  why,
});

const READY: ExpectedOutcome = { readiness: 'ready', findings: [] };

export const WORLD_REPOSITORIES: readonly WorldRepository[] = [
  {
    project: 'PLAT',
    slug: 'auto-ok',
    key: 'plat/auto-ok',
    plannedTargetName: 'plat-auto-ok',
    summary:
      'Mirrors the live e2e fixture: branches, annotated and lightweight tags, LFS, force and delete restrictions, a repository deploy key, unsecured variables, an environment.',
    coveredBy: 'Phase-1 scenario (TST-020)',
    analysis: {
      readiness: 'ready',
      findings: [],
    },
  },
  {
    project: 'DATA',
    slug: 'with-grants',
    key: 'data/with-grants',
    plannedTargetName: 'data-with-grants',
    summary:
      'User grants (alice by email, bob by login only) and a group grant, plus a push restriction naming the group.',
    coveredBy: 'T-086 (endpoint migration), not the Phase-1 scenario',
    analysis: {
      readiness: 'blocked',
      findings: [
        f(
          'access-control.team-missing',
          'blocker',
          'FAC-ACL-004: the group platform-team has no created target team (also referenced by the push restriction, FAC-006)',
        ),
        f(
          'access-control.unmapped-principal',
          'pre',
          'FAC-006: bob is only login-suggested (AUTH-050 step 2) until an operator confirms the mapping',
        ),
        f(
          'branch-rules.team-missing',
          'blocker',
          'FAC-006: the push restriction names the same group, which has no created target team',
        ),
      ],
    },
    stages: [
      {
        after: 'endpoint migration created the team platform-team and bob was confirmed',
        readiness: 'ready',
        findings: [],
      },
    ],
  },
  {
    project: 'PLAT',
    slug: 'with-secrets',
    key: 'plat/with-secrets',
    plannedTargetName: 'plat-with-secrets',
    summary: 'A secured repository variable next to an unsecured one.',
    coveredBy: 'Secrets post-task scenario',
    analysis: {
      readiness: 'ready',
      findings: [
        f(
          'secrets.set-value',
          'post',
          'FAC-SEC-001: a missing secret raises one post task per scope (repository)',
        ),
      ],
    },
  },
  {
    project: 'PLAT',
    slug: 'open-pr',
    key: 'plat/open-pr',
    plannedTargetName: 'plat-open-pr',
    summary: 'One open pull request.',
    coveredBy: 'Preflight re-check (LIF-041)',
    analysis: {
      readiness: 'blocked',
      findings: [f('change-requests.open', 'blocker', 'Any open Change Request blocks (FAC-CRQ)')],
    },
  },
  {
    project: 'DATA',
    slug: 'unmapped-user',
    key: 'data/unmapped-user',
    plannedTargetName: 'data-unmapped-user',
    summary: 'A direct grant to carol, who has no GitHub counterpart.',
    coveredBy: 'Run-anyway scenario (LIF-043)',
    analysis: {
      readiness: 'needs_attention',
      findings: [
        f(
          'access-control.unmapped-principal',
          'pre',
          'FAC-006: carol is unmapped (AUTH-050 step 4); the finding has completion `resolution`',
        ),
      ],
    },
  },
  {
    project: 'DATA',
    slug: 'pipelines-simple',
    key: 'data/pipelines-simple',
    plannedTargetName: 'data-pipelines-simple',
    summary: 'bitbucket-pipelines.yml that stays inside the FAC-PIP-002 translation subset.',
    coveredBy: 'Pipelines Change Request (LIF-047)',
    analysis: {
      readiness: 'ready',
      findings: [
        f(
          'pipelines.review-and-merge',
          'post',
          'FAC-PIP-003: fully supported translation is delivered as a Change Request',
        ),
      ],
    },
  },
  {
    project: 'DATA',
    slug: 'pipelines-pipes',
    key: 'data/pipelines-pipes',
    plannedTargetName: 'data-pipelines-pipes',
    summary: 'bitbucket-pipelines.yml using `pipe:` and `trigger: manual`, both unsupported.',
    coveredBy: 'Pipelines Change Request (LIF-047)',
    analysis: {
      readiness: 'ready',
      findings: [
        f(
          'pipelines.complete-translation',
          'post',
          'FAC-PIP-003: partial translation lists `pipe:` and `trigger: manual` in translation.unsupported',
        ),
      ],
    },
  },
  {
    project: 'OPS',
    slug: 'hooks',
    key: 'ops/hooks',
    plannedTargetName: 'ops-hooks',
    summary:
      'An allowlisted webhook (hooks.acme.example, no secret) and a non-allowlisted one with a secret.',
    coveredBy: 'Webhook allowlist (FAC-WEB-002)',
    analysis: {
      readiness: 'ready',
      findings: [
        f(
          'webhooks.recreate-manually',
          'post',
          'FAC-WEB-002: thirdparty.example is not allowlisted; it is omitted from desired and appears only as the task (the allowlisted hook is auto-created and raises nothing)',
        ),
      ],
    },
  },
  {
    project: 'OPS',
    slug: 'big-blob',
    key: 'ops/big-blob',
    plannedTargetName: 'ops-big-blob',
    summary: 'A 2 MiB blob while the fake target limit is 1 MiB.',
    coveredBy: 'Blob blocker scenario (LIF-049)',
    analysis: READY,
    stages: [
      {
        after: 'the first migrate Run failed at git.prepare',
        readiness: 'blocked',
        findings: [
          f(
            'git-refs.blob-too-large',
            'blocker',
            'FAC-GIT-004/LIF-049: run-origin blocker (Migration.runBlockers); analysis cannot see blobs',
          ),
        ],
      },
    ],
  },
  {
    project: 'OPS',
    slug: 'large-history',
    key: 'ops/large-history',
    plannedTargetName: 'ops-large-history',
    summary: '64 commits of 64 KiB (about 4 MiB) while the fake target push limit is 1 MiB.',
    coveredBy: 'Batched push scenario (LIF-044)',
    analysis: READY,
  },
  {
    project: 'OPS',
    slug: 'name-collision-a',
    key: 'ops/name-collision-a',
    plannedTargetName: 'ops-name-collision-a',
    summary: 'Collides with ops/name_collision_a: `kebab` maps both slugs to name-collision-a.',
    coveredBy: 'Naming collision (LIF-031)',
    analysis: {
      readiness: 'blocked',
      findings: [
        f('naming.collision', 'blocker', 'LIF-031: every member of the collision is blocked'),
      ],
    },
  },
  {
    project: 'OPS',
    slug: 'name_collision_a',
    key: 'ops/name_collision_a',
    plannedTargetName: 'ops-name-collision-a',
    summary: 'Collides with ops/name-collision-a.',
    coveredBy: 'Naming collision (LIF-031)',
    analysis: {
      readiness: 'blocked',
      findings: [
        f('naming.collision', 'blocker', 'LIF-031: every member of the collision is blocked'),
      ],
    },
  },
  {
    project: 'KEYS',
    slug: 'shared-key-1',
    key: 'keys/shared-key-1',
    plannedTargetName: 'keys-shared-key-1',
    summary: 'Inherits the project access key that shared-key-2 inherits too.',
    coveredBy: 'Deploy key pre-detection (FAC-DKY-003)',
    analysis: {
      readiness: 'ready',
      findings: [
        f(
          'deploy-keys.key-in-use',
          'post',
          'FAC-DKY-003: the same project key flattens into two source repositories on the Route',
        ),
      ],
    },
  },
  {
    project: 'KEYS',
    slug: 'shared-key-2',
    key: 'keys/shared-key-2',
    plannedTargetName: 'keys-shared-key-2',
    summary: 'Inherits the project access key that shared-key-1 inherits too.',
    coveredBy: 'Deploy key pre-detection (FAC-DKY-003)',
    analysis: {
      readiness: 'ready',
      findings: [
        f(
          'deploy-keys.key-in-use',
          'post',
          'FAC-DKY-003: the same project key flattens into two source repositories on the Route',
        ),
      ],
    },
  },
  {
    project: 'OPS',
    slug: 'wiki-issues',
    key: 'ops/wiki-issues',
    plannedTargetName: 'ops-wiki-issues',
    summary: 'Wiki with content, 3 issues and 2 downloads: detect-only.',
    coveredBy: 'Extras warnings (FAC-EXT-001)',
    analysis: {
      readiness: 'ready',
      findings: [
        f('extras.wiki-not-migrated', 'warning', 'FAC-EXT: the wiki repository has refs'),
        f('extras.issues-not-migrated', 'warning', 'FAC-EXT: has_issues and 3 issues'),
        f('extras.downloads-not-migrated', 'warning', 'FAC-EXT: 2 downloads'),
      ],
    },
  },
];

/** Looks a repository up by its TST-012 name, e.g. `plat/auto-ok`. */
export function worldRepository(key: string): WorldRepository {
  const repo = WORLD_REPOSITORIES.find((r) => r.key === key);
  if (!repo) throw new Error(`unknown world repository ${key}`);
  return repo;
}
