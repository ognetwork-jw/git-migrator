/**
 * Where a variable referenced as `$NAME` comes from on the target: an Actions variable or secret.
 * The sets come from the `variables` and `secrets` Facets (their `desired` documents) and the
 * workspace-level lists the caller provides; precedence follows the source: deployment, then
 * repository, then workspace.
 */
import { isIdentifier } from './safe.ts';

export interface VariableNames {
  readonly variables: ReadonlyMap<string, ReadonlySet<string>>; // scope -> names
  readonly secrets: ReadonlyMap<string, ReadonlySet<string>>;
}

export const NO_NAMES: VariableNames = { variables: new Map(), secrets: new Map() };

export const WORKSPACE_SCOPE = 'workspace';

function add(map: Map<string, Set<string>>, scope: string, name: string): void {
  const set = map.get(scope) ?? new Set<string>();
  set.add(name);
  map.set(scope, set);
}

function entries(doc: unknown, field: string): { scope: string; name: string }[] {
  if (typeof doc !== 'object' || doc === null) return [];
  const list = (doc as Record<string, unknown>)[field];
  if (!Array.isArray(list)) return [];
  const out: { scope: string; name: string }[] = [];
  for (const e of list) {
    if (typeof e !== 'object' || e === null) continue;
    const { scope, name } = e as Record<string, unknown>;
    if (typeof scope === 'string' && isIdentifier(name)) out.push({ scope, name });
  }
  return out;
}

/** Reads the dependency documents defensively: anything malformed is ignored, never trusted. */
export function variableNames(
  variablesDoc: unknown,
  secretsDoc: unknown,
  workspace: { variables?: readonly unknown[]; secrets?: readonly unknown[] } = {},
): VariableNames {
  const variables = new Map<string, Set<string>>();
  const secrets = new Map<string, Set<string>>();
  for (const e of entries(variablesDoc, 'variables')) add(variables, e.scope, e.name);
  for (const e of entries(secretsDoc, 'secrets')) add(secrets, e.scope, e.name);
  for (const n of workspace.variables ?? [])
    if (isIdentifier(n)) add(variables, WORKSPACE_SCOPE, n);
  for (const n of workspace.secrets ?? []) if (isIdentifier(n)) add(secrets, WORKSPACE_SCOPE, n);
  return { variables, secrets };
}

/** The `${{ … }}` expression for `$name`, or undefined when no such variable or secret exists. */
export function resolveVariable(
  names: VariableNames,
  name: string,
  environment: string | undefined,
): string | undefined {
  const scopes = [
    ...(environment === undefined ? [] : [`environment:${environment}`]),
    'repository',
    WORKSPACE_SCOPE,
  ];
  // Target names are upper-cased (variables.uppercase-names), so the lookup tries both spellings.
  for (const scope of scopes) {
    for (const candidate of new Set([name, name.toUpperCase()])) {
      if (names.secrets.get(scope)?.has(candidate)) return `\${{ secrets.${candidate} }}`;
      if (names.variables.get(scope)?.has(candidate)) return `\${{ vars.${candidate} }}`;
    }
  }
  return undefined;
}
