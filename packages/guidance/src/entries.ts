/**
 * Guidance for every Finding code (FAC-002, UI-040). The record is typed by `FindingCode`, so a code
 * added to `codes.ts` without an entry here fails `pnpm typecheck`. Message keys point into
 * `messages/en.json`. Shared keys (`shared.*`) cover the codes whose guidance is the same apart from
 * their parameters.
 */
import { type FindingCode, findingSpec } from './codes.ts';
import type { Guidance, GuidanceStep } from './types.ts';

const SHARED = {
  acceptLossyTitle: 'shared.accept-lossy.title',
  acceptLossySummary: 'shared.accept-lossy.summary',
  acceptLossyStep1: 'shared.accept-lossy.step.1',
  acceptLossyStep2: 'shared.accept-lossy.step.2',
  unmappedTitle: 'shared.unmapped-principal.title',
  unmappedSummary: 'shared.unmapped-principal.summary',
  unmappedStep1: 'shared.unmapped-principal.step.1',
  unmappedStep2: 'shared.unmapped-principal.step.2',
  pendingTitle: 'shared.pending-invitation.title',
  pendingSummary: 'shared.pending-invitation.summary',
  pendingStep1: 'shared.pending-invitation.step.1',
  pendingStep2: 'shared.pending-invitation.step.2',
} as const;

const VERIFICATION = {
  principals: 'verification.principals',
  statusChecks: 'verification.status-checks',
  hook: 'verification.hook',
  webhookSecret: 'verification.webhook-secret',
  deployKey: 'verification.deploy-key',
  secrets: 'verification.secrets',
  pipelines: 'verification.pipelines',
  codeowners: 'verification.codeowners',
  members: 'verification.members',
  teamMembership: 'verification.team-membership',
} as const;

/** Severity and the `(v)` marker come from `codes.ts`, the single source list. */
function base(code: FindingCode): Pick<Guidance, 'code' | 'severity' | 'verifiable'> {
  const spec = findingSpec(code);
  if (spec === undefined) throw new Error(`no finding spec for ${code}`);
  return { code, severity: spec.severity, verifiable: spec.verifiable };
}

function key(code: FindingCode, part: string): string {
  return `finding.${code}.${part}`;
}

function step(code: FindingCode, n: number, extra: Partial<GuidanceStep> = {}): GuidanceStep {
  return { text: key(code, `step.${n}`), ...extra };
}

function acceptLossy(code: FindingCode): Guidance {
  return {
    ...base(code),
    title: SHARED.acceptLossyTitle,
    summary: SHARED.acceptLossySummary,
    steps: [{ text: SHARED.acceptLossyStep1 }, { text: SHARED.acceptLossyStep2 }],
  };
}

function unmapped(code: FindingCode): Guidance {
  return {
    ...base(code),
    title: SHARED.unmappedTitle,
    summary: SHARED.unmappedSummary,
    steps: [{ text: SHARED.unmappedStep1 }, { text: SHARED.unmappedStep2 }],
  };
}

function pending(code: FindingCode, verification: string): Guidance {
  return {
    ...base(code),
    title: SHARED.pendingTitle,
    summary: SHARED.pendingSummary,
    steps: [{ text: SHARED.pendingStep1 }, { text: SHARED.pendingStep2 }],
    verification,
  };
}

function plain(code: FindingCode, steps: readonly GuidanceStep[], verification?: string): Guidance {
  return {
    ...base(code),
    title: key(code, 'title'),
    summary: key(code, 'summary'),
    steps,
    verification,
  };
}

export const GUIDANCE: Readonly<Record<FindingCode, Guidance>> = {
  // git-refs
  'git-refs.blob-too-large': plain('git-refs.blob-too-large', [
    step('git-refs.blob-too-large', 1, {
      copy: 'git lfs migrate info --everything --above={limit:shell}',
    }),
    step('git-refs.blob-too-large', 2),
  ]),
  'git-refs.blob-large': plain('git-refs.blob-large', [step('git-refs.blob-large', 1)]),
  'git-refs.push-too-large': plain('git-refs.push-too-large', [
    step('git-refs.push-too-large', 1),
    step('git-refs.push-too-large', 2),
  ]),
  'git-refs.hidden-refs-skipped': plain('git-refs.hidden-refs-skipped', [
    step('git-refs.hidden-refs-skipped', 1),
  ]),
  'git-refs.empty-repository': plain('git-refs.empty-repository', [
    step('git-refs.empty-repository', 1),
  ]),

  // repository-settings
  'repository-settings.accept-lossy': acceptLossy('repository-settings.accept-lossy'),
  'repository-settings.org-forking-disabled': plain('repository-settings.org-forking-disabled', [
    step('repository-settings.org-forking-disabled', 1),
    step('repository-settings.org-forking-disabled', 2),
  ]),
  'repository-settings.target-unreadable': plain('repository-settings.target-unreadable', [
    step('repository-settings.target-unreadable', 1),
    step('repository-settings.target-unreadable', 2),
  ]),
  'repository-settings.deletion-forbidden': plain('repository-settings.deletion-forbidden', [
    step('repository-settings.deletion-forbidden', 1),
    step('repository-settings.deletion-forbidden', 2),
  ]),

  'repository-settings.left-in-place': plain('repository-settings.left-in-place', [
    step('repository-settings.left-in-place', 1),
    step('repository-settings.left-in-place', 2),
    step('repository-settings.left-in-place', 3),
  ]),
  'repository-settings.deletion-unproven': plain('repository-settings.deletion-unproven', [
    step('repository-settings.deletion-unproven', 1),
    step('repository-settings.deletion-unproven', 2),
  ]),

  // merge-settings
  'merge-settings.accept-lossy': acceptLossy('merge-settings.accept-lossy'),

  // access-control
  'access-control.unmapped-principal': unmapped('access-control.unmapped-principal'),
  'access-control.pending-invitation': pending(
    'access-control.pending-invitation',
    VERIFICATION.principals,
  ),
  'access-control.team-missing': plain('access-control.team-missing', [
    step('access-control.team-missing', 1),
  ]),

  // branch-rules
  'branch-rules.accept-lossy': acceptLossy('branch-rules.accept-lossy'),
  'branch-rules.configure-status-checks': plain(
    'branch-rules.configure-status-checks',
    [step('branch-rules.configure-status-checks', 1)],
    VERIFICATION.statusChecks,
  ),
  'branch-rules.exemptions-not-applied': plain('branch-rules.exemptions-not-applied', [
    step('branch-rules.exemptions-not-applied', 1),
  ]),
  'branch-rules.protection-lifted': plain('branch-rules.protection-lifted', [
    step('branch-rules.protection-lifted', 1),
  ]),
  'branch-rules.source-lock-unsettled': plain('branch-rules.source-lock-unsettled', [
    step('branch-rules.source-lock-unsettled', 1),
    step('branch-rules.source-lock-unsettled', 2),
  ]),
  'branch-rules.unknown-kind': plain('branch-rules.unknown-kind', [
    step('branch-rules.unknown-kind', 1),
  ]),
  'branch-rules.branching-model': plain('branch-rules.branching-model', [
    step('branch-rules.branching-model', 1),
  ]),
  'branch-rules.unmapped-principal': unmapped('branch-rules.unmapped-principal'),
  'branch-rules.pending-invitation': pending(
    'branch-rules.pending-invitation',
    VERIFICATION.principals,
  ),
  'branch-rules.team-missing': plain('branch-rules.team-missing', [
    step('branch-rules.team-missing', 1),
  ]),

  // webhooks
  'webhooks.recreate-manually': plain(
    'webhooks.recreate-manually',
    [
      // Shell context: the URL may carry ; | & $( ) ` or a quote, so it is always single-quoted.
      step('webhooks.recreate-manually', 1, { copy: '{targetUrl:shell}' }),
      step('webhooks.recreate-manually', 2),
      step('webhooks.recreate-manually', 3, { when: 'hasSecret' }),
    ],
    VERIFICATION.hook,
  ),
  'webhooks.set-secret': plain(
    'webhooks.set-secret',
    [
      step('webhooks.set-secret', 1),
      step('webhooks.set-secret', 2, { when: 'activateAfterSecret' }),
    ],
    VERIFICATION.webhookSecret,
  ),
  'webhooks.duplicate-url': plain('webhooks.duplicate-url', [step('webhooks.duplicate-url', 1)]),
  'webhooks.accept-lossy': acceptLossy('webhooks.accept-lossy'),

  // deploy-keys
  'deploy-keys.key-in-use': plain(
    'deploy-keys.key-in-use',
    [
      step('deploy-keys.key-in-use', 1, {
        copy: 'ssh-keygen -t ed25519 -C {keyName:shell} -f deploy_key_ed25519',
      }),
      step('deploy-keys.key-in-use', 2),
      step('deploy-keys.key-in-use', 3),
    ],
    VERIFICATION.deployKey,
  ),

  // environments
  'environments.accept-lossy': acceptLossy('environments.accept-lossy'),
  'environments.name-collision': plain('environments.name-collision', [
    step('environments.name-collision', 1),
  ]),

  // variables and secrets
  'variables.accept-lossy': acceptLossy('variables.accept-lossy'),
  'variables.name-invalid': plain('variables.name-invalid', [step('variables.name-invalid', 1)]),
  'secrets.name-invalid': plain('secrets.name-invalid', [step('secrets.name-invalid', 1)]),
  'secrets.set-value': plain(
    'secrets.set-value',
    [
      step('secrets.set-value', 1, {
        copy: 'gh secret set {names:shell} --repo {repository:shell}',
        unless: 'environment',
      }),
      step('secrets.set-value', 2, {
        copy: 'gh secret set {names:shell} --repo {repository:shell} --env {environment:shell}',
        when: 'environment',
      }),
    ],
    VERIFICATION.secrets,
  ),

  // endpoint-level
  'org-secrets.set-value': plain(
    'org-secrets.set-value',
    [
      step('org-secrets.set-value', 1, {
        copy: 'gh secret set {names:shell} --org {namespace:shell} --visibility all',
      }),
    ],
    VERIFICATION.secrets,
  ),

  'org-secrets.name-invalid': plain('org-secrets.name-invalid', [
    step('org-secrets.name-invalid', 1),
  ]),
  'org-variables.accept-lossy': acceptLossy('org-variables.accept-lossy'),
  'org-variables.name-invalid': plain('org-variables.name-invalid', [
    step('org-variables.name-invalid', 1),
  ]),
  'org-webhooks.recreate-manually': plain(
    'org-webhooks.recreate-manually',
    [
      // Shell context: the URL may carry ; | & $( ) ` or a quote, so it is always single-quoted.
      step('org-webhooks.recreate-manually', 1, { copy: '{targetUrl:shell}' }),
      step('org-webhooks.recreate-manually', 2),
      step('org-webhooks.recreate-manually', 3, { when: 'hasSecret' }),
    ],
    VERIFICATION.hook,
  ),
  'org-webhooks.set-secret': plain(
    'org-webhooks.set-secret',
    [
      step('org-webhooks.set-secret', 1),
      step('org-webhooks.set-secret', 2, { when: 'activateAfterSecret' }),
    ],
    VERIFICATION.webhookSecret,
  ),
  'org-webhooks.accept-lossy': acceptLossy('org-webhooks.accept-lossy'),

  // pipelines
  'pipelines.review-and-merge': plain(
    'pipelines.review-and-merge',
    [step('pipelines.review-and-merge', 1)],
    VERIFICATION.pipelines,
  ),
  'pipelines.complete-translation': plain(
    'pipelines.complete-translation',
    [step('pipelines.complete-translation', 1)],
    VERIFICATION.pipelines,
  ),
  'pipelines.disabled': plain('pipelines.disabled', [step('pipelines.disabled', 1)]),

  // code-ownership
  'code-ownership.review-and-merge': plain(
    'code-ownership.review-and-merge',
    [step('code-ownership.review-and-merge', 1)],
    VERIFICATION.codeowners,
  ),
  'code-ownership.accept-lossy': acceptLossy('code-ownership.accept-lossy'),
  'code-ownership.team-missing': plain('code-ownership.team-missing', [
    step('code-ownership.team-missing', 1),
  ]),
  'code-ownership.team-membership-unknown': plain('code-ownership.team-membership-unknown', [
    step('code-ownership.team-membership-unknown', 1),
  ]),
  'code-ownership.unmapped-principal': unmapped('code-ownership.unmapped-principal'),
  'code-ownership.pending-invitation': pending(
    'code-ownership.pending-invitation',
    VERIFICATION.principals,
  ),

  // change-requests
  'change-requests.open': plain('change-requests.open', [step('change-requests.open', 1)]),

  // extras
  'extras.wiki-not-migrated': plain('extras.wiki-not-migrated', [
    step('extras.wiki-not-migrated', 1),
  ]),
  'extras.issues-not-migrated': plain('extras.issues-not-migrated', [
    step('extras.issues-not-migrated', 1),
  ]),
  'extras.downloads-not-migrated': plain('extras.downloads-not-migrated', [
    step('extras.downloads-not-migrated', 1),
  ]),

  // members
  'members.review-identity-mapping': plain('members.review-identity-mapping', [
    step('members.review-identity-mapping', 1),
  ]),
  'members.approve-invitations': plain('members.approve-invitations', [
    step('members.approve-invitations', 1),
  ]),
  'members.pending-acceptance': plain(
    'members.pending-acceptance',
    [step('members.pending-acceptance', 1)],
    VERIFICATION.members,
  ),

  // teams
  'teams.slug-collision': plain('teams.slug-collision', [step('teams.slug-collision', 1)]),
  'teams.slug-invalid': plain('teams.slug-invalid', [step('teams.slug-invalid', 1)]),
  'teams.set-membership': plain(
    'teams.set-membership',
    [step('teams.set-membership', 1)],
    VERIFICATION.teamMembership,
  ),
  'teams.unmapped-principal': unmapped('teams.unmapped-principal'),
  'teams.pending-invitation': pending('teams.pending-invitation', VERIFICATION.principals),
  // lifecycle (LIF-031)
  'naming.invalid': plain('naming.invalid', [step('naming.invalid', 1), step('naming.invalid', 2)]),
  'naming.collision': plain('naming.collision', [
    step('naming.collision', 1),
    step('naming.collision', 2),
  ]),
  'target.exists-nonempty': plain('target.exists-nonempty', [
    step('target.exists-nonempty', 1),
    step('target.exists-nonempty', 2),
  ]),
  'target.owned-by-other-migration': plain('target.owned-by-other-migration', [
    step('target.owned-by-other-migration', 1),
    step('target.owned-by-other-migration', 2),
    step('target.owned-by-other-migration', 3),
  ]),
};
