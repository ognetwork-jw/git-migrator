/**
 * The single source list of Finding codes emitted by built-in Facets (FAC-002).
 *
 * Each row mirrors one entry in the "Findings" lines of docs/spec/05-facets.md, or one of the
 * facet-specific codes that the spec names in its text. `*.test.ts` cross-checks this list against
 * the spec, so drift in either direction fails the test suite.
 *
 * Severity follows the spec notation: `blocker` (B), `pre` (pre-run Manual Task), `post` (post-run
 * Manual Task), `warning` (W). `verifiable` is the spec's `(v)` marker: Parity completes the task.
 *
 * Generic principal codes (`<facet>.unmapped-principal`, `<facet>.pending-invitation`) come from
 * FAC-006 and are listed for every facet whose documents contain principals (ADR-0090).
 */

export const SEVERITIES = ['blocker', 'pre', 'post', 'warning'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface FindingSpec {
  readonly code: string;
  readonly facet: string;
  readonly severity: Severity;
  readonly verifiable: boolean;
  /** Spec section that defines the code. */
  readonly ref: string;
}

export const FINDING_SPECS = [
  // git-refs
  {
    code: 'git-refs.blob-too-large',
    facet: 'git-refs',
    severity: 'blocker',
    verifiable: false,
    ref: 'FAC-GIT-004',
  },
  {
    code: 'git-refs.blob-large',
    facet: 'git-refs',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-GIT-004',
  },
  {
    code: 'git-refs.hidden-refs-skipped',
    facet: 'git-refs',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-GIT-002',
  },
  {
    code: 'git-refs.empty-repository',
    facet: 'git-refs',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-GIT',
  },
  // repository-settings
  {
    code: 'repository-settings.accept-lossy',
    facet: 'repository-settings',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-SET',
  },
  {
    code: 'repository-settings.org-forking-disabled',
    facet: 'repository-settings',
    severity: 'post',
    verifiable: false,
    ref: 'FAC-SET-002',
  },
  // merge-settings
  {
    code: 'merge-settings.accept-lossy',
    facet: 'merge-settings',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-MRG',
  },
  // access-control
  {
    code: 'access-control.unmapped-principal',
    facet: 'access-control',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-ACL-003',
  },
  {
    code: 'access-control.pending-invitation',
    facet: 'access-control',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-ACL-003',
  },
  {
    code: 'access-control.team-missing',
    facet: 'access-control',
    severity: 'blocker',
    verifiable: false,
    ref: 'FAC-ACL-004',
  },
  // branch-rules
  {
    code: 'branch-rules.accept-lossy',
    facet: 'branch-rules',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-BRR',
  },
  {
    code: 'branch-rules.configure-status-checks',
    facet: 'branch-rules',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-BRR-002',
  },
  {
    code: 'branch-rules.unknown-kind',
    facet: 'branch-rules',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-BRR-001',
  },
  {
    code: 'branch-rules.branching-model',
    facet: 'branch-rules',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-BRR',
  },
  {
    code: 'branch-rules.unmapped-principal',
    facet: 'branch-rules',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-006',
  },
  {
    code: 'branch-rules.pending-invitation',
    facet: 'branch-rules',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-006',
  },
  // webhooks
  {
    code: 'webhooks.recreate-manually',
    facet: 'webhooks',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-WEB-002',
  },
  {
    code: 'webhooks.set-secret',
    facet: 'webhooks',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-WEB-003',
  },
  {
    // Agent-decided (ADR-0141): ADR-0088 requires a finding for duplicate-URL hooks.
    code: 'webhooks.duplicate-url',
    facet: 'webhooks',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-WEB',
  },
  {
    code: 'webhooks.accept-lossy',
    facet: 'webhooks',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-WEB',
  },
  // deploy-keys
  {
    code: 'deploy-keys.key-in-use',
    facet: 'deploy-keys',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-DKY-002',
  },
  // environments
  {
    code: 'environments.accept-lossy',
    facet: 'environments',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-ENV',
  },
  {
    code: 'environments.name-collision',
    facet: 'environments',
    severity: 'pre',
    verifiable: false,
    ref: 'ADR-0145',
  },
  // variables and secrets
  {
    code: 'variables.accept-lossy',
    facet: 'variables',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-VAR-003',
  },
  {
    code: 'variables.name-invalid',
    facet: 'variables',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-VAR-003',
  },
  {
    code: 'secrets.name-invalid',
    facet: 'secrets',
    severity: 'pre',
    verifiable: false,
    ref: 'ADR-0145',
  },
  {
    code: 'secrets.set-value',
    facet: 'secrets',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-SEC-001',
  },
  // endpoint-level: org-variables, org-secrets, org-webhooks
  {
    code: 'org-secrets.set-value',
    facet: 'org-secrets',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-END org-variables',
  },
  // Agent-decided (ADR-0151, ADR-0152): the org-level counterparts of the repository codes.
  {
    code: 'org-secrets.name-invalid',
    facet: 'org-secrets',
    severity: 'pre',
    verifiable: false,
    ref: 'ADR-0151',
  },
  {
    code: 'org-variables.accept-lossy',
    facet: 'org-variables',
    severity: 'pre',
    verifiable: false,
    ref: 'ADR-0151',
  },
  {
    code: 'org-variables.name-invalid',
    facet: 'org-variables',
    severity: 'pre',
    verifiable: false,
    ref: 'ADR-0151',
  },
  {
    code: 'org-webhooks.recreate-manually',
    facet: 'org-webhooks',
    severity: 'post',
    verifiable: true,
    ref: 'ADR-0152',
  },
  {
    code: 'org-webhooks.set-secret',
    facet: 'org-webhooks',
    severity: 'post',
    verifiable: true,
    ref: 'ADR-0152',
  },
  {
    code: 'org-webhooks.accept-lossy',
    facet: 'org-webhooks',
    severity: 'pre',
    verifiable: false,
    ref: 'ADR-0152',
  },
  // pipelines
  {
    code: 'pipelines.review-and-merge',
    facet: 'pipelines',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-PIP-003',
  },
  {
    code: 'pipelines.complete-translation',
    facet: 'pipelines',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-PIP-003',
  },
  {
    code: 'pipelines.disabled',
    facet: 'pipelines',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-PIP-003',
  },
  // code-ownership
  {
    code: 'code-ownership.review-and-merge',
    facet: 'code-ownership',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-COD',
  },
  {
    code: 'code-ownership.accept-lossy',
    facet: 'code-ownership',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-COD',
  },
  {
    code: 'code-ownership.unmapped-principal',
    facet: 'code-ownership',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-006',
  },
  {
    code: 'code-ownership.pending-invitation',
    facet: 'code-ownership',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-006',
  },
  {
    code: 'code-ownership.team-missing',
    facet: 'code-ownership',
    severity: 'blocker',
    verifiable: false,
    ref: 'FAC-006',
  },
  {
    code: 'code-ownership.team-membership-unknown',
    facet: 'code-ownership',
    severity: 'warning',
    verifiable: false,
    ref: 'ADR-0106',
  },
  // change-requests
  {
    code: 'change-requests.open',
    facet: 'change-requests',
    severity: 'blocker',
    verifiable: false,
    ref: 'FAC-CRQ',
  },
  // extras (detect-only warnings)
  {
    code: 'extras.wiki-not-migrated',
    facet: 'extras',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-EXT',
  },
  {
    code: 'extras.issues-not-migrated',
    facet: 'extras',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-EXT',
  },
  {
    code: 'extras.downloads-not-migrated',
    facet: 'extras',
    severity: 'warning',
    verifiable: false,
    ref: 'FAC-EXT',
  },
  // members
  {
    code: 'members.review-identity-mapping',
    facet: 'members',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-END members',
  },
  {
    code: 'members.approve-invitations',
    facet: 'members',
    severity: 'post',
    verifiable: false,
    ref: 'FAC-END members',
  },
  {
    code: 'members.pending-acceptance',
    facet: 'members',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-END members',
  },
  // teams
  {
    code: 'teams.slug-collision',
    facet: 'teams',
    severity: 'blocker',
    verifiable: false,
    ref: 'FAC-END teams',
  },
  {
    // Agent-decided (ADR-0150): the naming pipeline produced no usable slug for the group.
    code: 'teams.slug-invalid',
    facet: 'teams',
    severity: 'blocker',
    verifiable: false,
    ref: 'ADR-0150',
  },
  {
    code: 'teams.set-membership',
    facet: 'teams',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-END teams',
  },
  {
    code: 'teams.unmapped-principal',
    facet: 'teams',
    severity: 'pre',
    verifiable: false,
    ref: 'FAC-006',
  },
  {
    code: 'teams.pending-invitation',
    facet: 'teams',
    severity: 'post',
    verifiable: true,
    ref: 'FAC-006',
  },
  // lifecycle (LIF-031 blockers, raised by the Migration lifecycle rather than a Facet)
  {
    code: 'naming.invalid',
    facet: 'lifecycle',
    severity: 'blocker',
    verifiable: false,
    ref: 'LIF-031',
  },
  {
    code: 'naming.collision',
    facet: 'lifecycle',
    severity: 'blocker',
    verifiable: false,
    ref: 'LIF-031',
  },
  {
    code: 'target.exists-nonempty',
    facet: 'lifecycle',
    severity: 'blocker',
    verifiable: false,
    ref: 'LIF-031',
  },
  {
    code: 'target.owned-by-other-migration',
    facet: 'lifecycle',
    severity: 'blocker',
    verifiable: false,
    ref: 'LIF-031 (pending spec)',
  },
] as const satisfies readonly FindingSpec[];

/** Every finding code that a built-in Facet may emit (FAC-002). */
export type FindingCode = (typeof FINDING_SPECS)[number]['code'];

export const FINDING_CODES: readonly FindingCode[] = FINDING_SPECS.map((s) => s.code);

/** Facets whose documents contain principals and therefore resolve them through FAC-006. */
export const PRINCIPAL_FACETS = [
  'access-control',
  'branch-rules',
  'code-ownership',
  'teams',
] as const;

export function findingSpec(code: string): FindingSpec | undefined {
  return FINDING_SPECS.find((s) => s.code === code);
}
