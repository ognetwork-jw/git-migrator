/**
 * Typed parameters for guidance templates (UI-040).
 *
 * Every placeholder in a guidance message or copy snippet must name an entry of `PARAMS`. The kind
 * decides what values are accepted, and the template context decides how an accepted value is
 * escaped (see `template.ts`). A value that does not match its kind is treated as missing, so a
 * bad value never reaches the output as "undefined", "null", "NaN" or an unescaped string.
 */

export const PARAM_KINDS = ['text', 'url', 'integer', 'list', 'flag', 'entries'] as const;
export type ParamKind = (typeof PARAM_KINDS)[number];

export const PARAMS = {
  repository: { kind: 'text', description: 'Target repository full name, owner/name.' },
  namespace: { kind: 'text', description: 'Target Namespace login.' },
  targetUrl: {
    kind: 'url',
    description: 'Absolute URL of a target-side resource, such as a hook.',
  },
  targetUrlDisplay: {
    kind: 'text',
    description:
      'Origin of targetUrl with the path and query masked, for display. Derived when not supplied.',
  },
  names: { kind: 'list', description: 'Variable or secret names.' },
  details: {
    kind: 'entries',
    description:
      'What a rollback left in place, one {kind, name} entry per change. Each kind renders through the message `entry.details.<kind>`.',
    entryKinds: [
      'group-unproven',
      'group-renamed',
      'group-has-children',
      'group-changed',
      'group-in-use',
      'group-membership-in-use',
      'branch-rule-replaced',
      'branch-rule-exists',
      'repository-earlier',
    ],
  },
  entryName: {
    kind: 'text',
    description: 'The name in one entry of an entries parameter. Supplied by the renderer.',
  },
  scope: { kind: 'text', description: 'Scope label, "repository" or "environment:<name>".' },
  environment: { kind: 'text', description: 'Deployment environment name.' },
  policyKey: { kind: 'text', description: 'Policy key, <facet>.<name>.' },
  paths: { kind: 'list', description: 'Affected field or file paths.' },
  path: { kind: 'text', description: 'One file path.' },
  size: { kind: 'text', description: 'Human-readable size, such as "120 MiB".' },
  limit: { kind: 'text', description: 'Size limit without spaces, such as 100MiB.' },
  count: { kind: 'integer', description: 'A count of items.' },
  ids: { kind: 'list', description: 'Identifiers and titles of open Change Requests.' },
  refs: { kind: 'list', description: 'Ignored ref names.' },
  kinds: { kind: 'list', description: 'Unrecognized restriction kinds.' },
  pattern: { kind: 'text', description: 'Branch or ownership pattern.' },
  principal: { kind: 'text', description: 'Principal display name or login.' },
  facet: { kind: 'text', description: 'Facet key the principal belongs to.' },
  team: { kind: 'text', description: 'Team slug.' },
  groups: { kind: 'list', description: 'Source group names that share a team slug.' },
  events: { kind: 'list', description: 'Canonical event names.' },
  workflowPath: { kind: 'text', description: 'Generated workflow path.' },
  branch: { kind: 'text', description: 'Branch that holds a generated change.' },
  keyName: { kind: 'text', description: 'Deploy key title or file name.' },
  unsupported: { kind: 'list', description: 'YAML paths of unsupported pipeline constructs.' },
  hasSecret: {
    kind: 'flag',
    description:
      'True when the hook had a secret on the source. The value is never read or carried.',
  },
  activateAfterSecret: {
    kind: 'flag',
    description:
      'True when the hook was active on the source and should be activated after its secret is set.',
  },
} as const satisfies Record<
  string,
  {
    readonly kind: ParamKind;
    readonly description: string;
    /** For `entries`: the kinds an entry may have. */
    readonly entryKinds?: readonly string[];
  }
>;

export type ParamName = keyof typeof PARAMS;

/**
 * One entry of an `entries` parameter: a kind, rendered through the message
 * `entry.<param>.<kind>`, and the name it is about (inserted as `{entryName}`).
 */
export interface ParamEntry {
  readonly kind: string;
  readonly name: string;
}

type ValueOf<K extends ParamKind> = K extends 'text' | 'url'
  ? string
  : K extends 'integer'
    ? number
    : K extends 'flag'
      ? boolean
      : K extends 'entries'
        ? readonly ParamEntry[]
        : readonly string[];

/** Values a caller may supply, typed by each parameter's kind. Omitted or null means missing. */
export type ParamValues = {
  readonly [N in ParamName]?: ValueOf<(typeof PARAMS)[N]['kind']> | null;
};

export const PARAM_NAMES = Object.keys(PARAMS) as ParamName[];

export function isParamName(name: string): name is ParamName {
  return Object.hasOwn(PARAMS, name);
}

/** The parameters of kind `entries`, with the message key of each of their kinds. */
export function entryMessageKeys(): string[] {
  const keys: string[] = [];
  for (const [name, spec] of Object.entries(PARAMS)) {
    if (spec.kind !== 'entries') continue;
    for (const kind of (spec as { readonly entryKinds?: readonly string[] }).entryKinds ?? []) {
      keys.push(entryMessageKey(name, kind));
    }
  }
  return keys;
}

export function entryMessageKey(param: string, kind: string): string {
  return `entry.${param}.${kind}`;
}
