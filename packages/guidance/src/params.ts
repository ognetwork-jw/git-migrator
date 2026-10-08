/**
 * Typed parameters for guidance templates (UI-040).
 *
 * Every placeholder in a guidance message or copy snippet must name an entry of `PARAMS`. The kind
 * decides what values are accepted, and the template context decides how an accepted value is
 * escaped (see `template.ts`). A value that does not match its kind is treated as missing, so a
 * bad value never reaches the output as "undefined", "null", "NaN" or an unescaped string.
 */

export const PARAM_KINDS = ['text', 'url', 'integer', 'list'] as const;
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
} as const satisfies Record<string, { readonly kind: ParamKind; readonly description: string }>;

export type ParamName = keyof typeof PARAMS;

type ValueOf<K extends ParamKind> = K extends 'text' | 'url'
  ? string
  : K extends 'integer'
    ? number
    : readonly string[];

/** Values a caller may supply, typed by each parameter's kind. Omitted or null means missing. */
export type ParamValues = {
  readonly [N in ParamName]?: ValueOf<(typeof PARAMS)[N]['kind']> | null;
};

export const PARAM_NAMES = Object.keys(PARAMS) as ParamName[];

export function isParamName(name: string): name is ParamName {
  return Object.hasOwn(PARAMS, name);
}
