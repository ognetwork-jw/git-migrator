/**
 * The naming rule editor's draft and its save gate (UI-030, LIF-030, LIF-031). Pure: nothing here
 * reads the network, so the rules the page enforces can be tested without rendering it.
 */

export const NAMING_VARS = ['namespace', 'repository', 'group'] as const;
export const INIT_OPS = ['projectKey', 'slug', 'name'] as const;
export const TRANSFORM_OPS = ['lowercase', 'kebab', 'truncate', 'replace'] as const;
export const ALL_OPS: readonly string[] = [...INIT_OPS, ...TRANSFORM_OPS];

/** API-020 body limits (`NamingRuleBodySchema`, `NamingPipelineSchema`). */
export const MAX_STEPS = 50;
export const MAX_TEMPLATE = 256;
export const MAX_VAR = 64;
export const MAX_PATTERN = 400;
export const MAX_OVERRIDE = 256;

export type Scope = 'namespace' | 'repository';
export type RuleMode = 'pipeline' | 'override';

export interface StepDraft {
  /** A client-side key for the editor's rows; it is never sent. */
  readonly uid: string;
  readonly var: string;
  readonly op: string;
  readonly arg: number | null;
  readonly pattern: string;
  readonly with: string;
}

export interface PipelineDraft {
  readonly steps: readonly StepDraft[];
  readonly template: string;
}

export interface RuleDraft {
  readonly scope: Scope;
  readonly scopeRef: string;
  readonly mode: RuleMode;
  readonly pipeline: PipelineDraft;
  readonly override: string;
}

/** A step as the RPC and the preview take it: only the fields its op uses. */
export type StepPayload =
  | { readonly var: string; readonly op: string }
  | { readonly var: string; readonly op: 'truncate'; readonly arg: number }
  | {
      readonly var: string;
      readonly op: 'replace';
      readonly pattern: string;
      readonly with: string;
    };

export type PipelinePayload = { readonly steps: readonly StepPayload[]; readonly template: string };

/** The rule body the preview takes (`{rule}`) and the RPC stores, without the route. */
export type RuleBody =
  | { readonly scope: Scope; readonly scopeRef: string; readonly pipeline: PipelinePayload }
  | { readonly scope: 'repository'; readonly scopeRef: string; readonly override: string };

/**
 * The `pipeline` column is required in the database (NamingRule.pipeline). An override rule has no
 * pipeline of its own, so it stores this empty one; the override wins over it (LIF-030).
 */
export const OVERRIDE_PLACEHOLDER_PIPELINE: PipelinePayload = { steps: [], template: '' };

let stepCounter = 0;
const nextUid = () => {
  stepCounter += 1;
  return `step-${stepCounter}`;
};

/** A step row with the given fields; the client-side `uid` is filled in. */
export function makeStep(fields: Omit<StepDraft, 'uid'>): StepDraft {
  return { uid: nextUid(), ...fields };
}

/** The LIF-030 default pipeline. */
export function defaultPipeline(): PipelineDraft {
  return {
    steps: [
      makeStep({ var: 'namespace', op: 'projectKey', arg: null, pattern: '', with: '' }),
      makeStep({ var: 'namespace', op: 'lowercase', arg: null, pattern: '', with: '' }),
      makeStep({ var: 'repository', op: 'slug', arg: null, pattern: '', with: '' }),
      makeStep({ var: 'repository', op: 'kebab', arg: null, pattern: '', with: '' }),
    ],
    template: '{namespace}-{repository}',
  };
}

export function emptyStep(): StepDraft {
  return makeStep({ var: 'repository', op: 'lowercase', arg: null, pattern: '', with: '' });
}

/** The step as the API takes it: fields the op does not use are left out. */
export function stepPayload(step: StepDraft): StepPayload {
  if (step.op === 'truncate') return { var: step.var, op: 'truncate', arg: step.arg ?? 0 };
  if (step.op === 'replace') {
    return { var: step.var, op: 'replace', pattern: step.pattern, with: step.with };
  }
  return { var: step.var, op: step.op };
}

export function pipelinePayload(pipeline: PipelineDraft): PipelinePayload {
  return { steps: pipeline.steps.map(stepPayload), template: pipeline.template };
}

/**
 * The problems of a draft, as keys under `config.naming.problem`. An empty list means the draft can
 * be previewed and saved. The server still has the last word (API-011).
 */
export function draftProblems(draft: RuleDraft): string[] {
  const problems = new Set<string>();
  if (draft.scopeRef === '') problems.add('scope');
  if (draft.mode === 'override') {
    if (draft.scope !== 'repository') problems.add('overrideScope');
    const value = draft.override.trim();
    if (value === '' || value.length > MAX_OVERRIDE) problems.add('override');
    return [...problems];
  }
  const { steps, template } = draft.pipeline;
  if (steps.length === 0 || steps.length > MAX_STEPS) problems.add('steps');
  if (template.trim() === '' || template.length > MAX_TEMPLATE) problems.add('template');
  for (const step of steps) {
    if (step.var.trim() === '' || step.var.length > MAX_VAR) problems.add('var');
    if (!ALL_OPS.includes(step.op)) problems.add('op');
    if (
      step.op === 'truncate' &&
      (step.arg === null || !Number.isInteger(step.arg) || step.arg < 1)
    ) {
      problems.add('truncateArg');
    }
    if (step.op === 'replace') {
      if (step.pattern === '' || step.pattern.length > MAX_PATTERN) problems.add('pattern');
      if (step.with.length > MAX_PATTERN) problems.add('with');
    }
  }
  return [...problems];
}

/** The rule body for a valid draft. Call only when `draftProblems` is empty. */
export function ruleBody(draft: RuleDraft): RuleBody {
  if (draft.mode === 'override') {
    return { scope: 'repository', scopeRef: draft.scopeRef, override: draft.override.trim() };
  }
  return {
    scope: draft.scope,
    scopeRef: draft.scopeRef,
    pipeline: pipelinePayload(draft.pipeline),
  };
}

/** Identifies a draft's rule body; a preview only counts for the body it was run on. */
export const bodyKey = (body: RuleBody): string => JSON.stringify(body);

/** What a preview of one draft answered (API-020, `NamingPreview`). */
export interface PreviewResult {
  readonly summary: {
    readonly affected: number;
    readonly changed: number;
    readonly invalid: number;
    readonly colliding: number;
  };
  readonly collisions: readonly { readonly key: string; readonly members: readonly string[] }[];
  readonly items: readonly PreviewItem[];
  readonly nextCursor: string | null;
}

export interface PreviewItem {
  readonly migrationId: string;
  readonly sourcePath: string;
  readonly inScope: boolean;
  readonly currentName: string | null;
  readonly plannedName: string | null;
  readonly changed: boolean;
  readonly ruleSource: string;
  readonly findings: readonly { readonly code: string; readonly severity: string }[];
}

/** The last preview run from the editor: the body it was run on, and its answer or failure. */
export interface PreviewState {
  readonly key: string;
  readonly body: RuleBody;
  readonly result?: PreviewResult;
  readonly failure?: string;
}

export type SaveBlock =
  | 'invalid'
  | 'no-preview'
  | 'stale-preview'
  | 'preview-unavailable'
  | 'collisions-unconfirmed';

/**
 * LIF-031 `naming.collision` at save time (UI-030 acceptance): a rule that puts repositories on the
 * same planned name is not saved unless the operator confirms it. The save needs a preview of the
 * exact body being saved; a preview that failed (for example above the 20,000-repository limit,
 * ADR-0331) cannot show the collisions, so it blocks too. Returns the reason, or `undefined` to allow.
 */
export function saveBlock(input: {
  readonly valid: boolean;
  readonly key: string;
  readonly preview: PreviewState | undefined;
  readonly confirmed: boolean;
}): SaveBlock | undefined {
  if (!input.valid) return 'invalid';
  if (input.preview === undefined) return 'no-preview';
  if (input.preview.key !== input.key) return 'stale-preview';
  if (input.preview.result === undefined) return 'preview-unavailable';
  if (input.preview.result.collisions.length > 0 && !input.confirmed) {
    return 'collisions-unconfirmed';
  }
  return undefined;
}
