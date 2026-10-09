/**
 * Pure helpers of the Analysis: what a translate context is made of (FAC-006 resolvers, the route
 * index), LIF-045 source-side filtering and the mapping of adapter read warnings to plan warnings.
 * No I/O. Decisions: docs/adr/0310-analysis-processor.md, 0311-analysis-route-index.md.
 */
import {
  canonicalFieldPath,
  type FacetDefinition,
  type IdentityResolver,
  type PrincipalRef,
  type PrincipalResolution,
  parseFieldPath,
} from '@git-migrator/core';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;

/** Every principal reference (`{ kind: 'identity' | 'group', id }`) in a canonical document. */
export function collectPrincipals(
  doc: unknown,
  into: Map<string, PrincipalRef> = new Map(),
): Map<string, PrincipalRef> {
  if (Array.isArray(doc)) {
    for (const item of doc) collectPrincipals(item, into);
  } else if (isObject(doc)) {
    const { kind, id } = doc;
    if ((kind === 'identity' || kind === 'group') && typeof id === 'string') {
      into.set(`${kind}:${id}`, { kind, id });
    }
    for (const v of Object.values(doc)) collectPrincipals(v, into);
  }
  return into;
}

export interface MappingRow {
  readonly status: string;
  readonly sourceProviderId: string;
  readonly targetProviderId: string | null;
  /** Groups only: the slug of the target team, to tell a team that was renamed or deleted. */
  readonly targetSlug?: string | null;
}

/** FAC-006 for identities: only a confirmed mapping with a target resolves to a principal. */
export function identityResolver(rows: readonly MappingRow[]): IdentityResolver {
  const bySource = new Map(rows.map((r) => [r.sourceProviderId, r]));
  return {
    resolve(principal): PrincipalResolution {
      const row = bySource.get(principal.id);
      if (!row) return { status: 'unmapped' };
      if (row.status === 'confirmed' && row.targetProviderId !== null) {
        return { status: 'mapped', principal: { kind: 'identity', id: row.targetProviderId } };
      }
      if (row.status === 'excluded') return { status: 'excluded' };
      if (row.status === 'pending_invite') return { status: 'pending_invite' };
      return { status: 'unmapped' };
    },
  };
}

/**
 * FAC-006 for groups (ADR-0310): a confirmed mapping is a created target team; a team that exists
 * but is only suggested still needs an operator (`unmapped`); a group with no team is
 * `team_missing`. Group ids compare case-insensitively.
 */
export function groupResolver(rows: readonly MappingRow[]): IdentityResolver {
  const bySource = new Map(rows.map((r) => [r.sourceProviderId.toLowerCase(), r]));
  return {
    resolve(principal): PrincipalResolution {
      const row = bySource.get(principal.id.toLowerCase());
      if (!row) return { status: 'team_missing' };
      if (row.status === 'confirmed' && row.targetProviderId !== null) {
        return { status: 'mapped', principal: { kind: 'group', id: row.targetProviderId } };
      }
      if (row.status === 'excluded') return { status: 'excluded' };
      if (row.status === 'suggested') return { status: 'unmapped' };
      return { status: 'team_missing' };
    },
  };
}

/** The public keys of a deploy-keys document. */
export function deployKeysOf(doc: unknown): string[] {
  const keys = isObject(doc) && Array.isArray(doc.keys) ? doc.keys : [];
  return keys.flatMap((k) => (isObject(k) && typeof k.publicKey === 'string' ? [k.publicKey] : []));
}

/**
 * FAC-DKY-003: how many source repositories on the Route carry each key. `others` are the keys of
 * the stored Snapshots of the other present repositories; `own` are the keys just read.
 */
export function deployKeyUsage(
  others: ReadonlyMap<string, readonly string[]>,
  own: readonly string[],
): Record<string, number> {
  const usage = new Map<string, number>();
  for (const keys of others.values()) {
    for (const key of new Set(keys)) usage.set(key, (usage.get(key) ?? 0) + 1);
  }
  for (const key of new Set(own)) usage.set(key, (usage.get(key) ?? 0) + 1);
  return Object.fromEntries(usage);
}

/** Names in a list-shaped canonical document (`org-variables`, `org-secrets`). */
export function namesOf(doc: unknown): string[] {
  if (!isObject(doc)) return [];
  const list = Object.values(doc).find(Array.isArray) as unknown[] | undefined;
  return (list ?? []).flatMap((e) => (isObject(e) && typeof e.name === 'string' ? [e.name] : []));
}

type Segments = ReturnType<typeof parseFieldPath>;

/**
 * LIF-045: removes what the framework itself created on the source before translation. Each path
 * of an active source-side `create` Mutation addresses either a keyed collection element (removed
 * whole) or a plain field (removed). The input is not mutated.
 */
export function withoutFrameworkCreated(doc: unknown, paths: readonly string[]): unknown {
  let out = structuredClone(doc);
  for (const path of paths) {
    let segments: Segments;
    try {
      segments = parseFieldPath(canonicalFieldPath(path));
    } catch {
      continue;
    }
    out = removeAt(out, segments);
  }
  return out;
}

function removeAt(node: unknown, segments: Segments): unknown {
  const [head, ...rest] = segments;
  if (head === undefined || !isObject(node)) return node;
  const child = node[head.name];
  if (head.key === undefined) {
    if (rest.length === 0) {
      const { [head.name]: _removed, ...kept } = node;
      return kept;
    }
    return child === undefined ? node : { ...node, [head.name]: removeAt(child, rest) };
  }
  if (!Array.isArray(child)) return node;
  const { field, value } = head.key;
  const matches = (item: unknown): boolean => matchesKey(item, field, value);
  if (rest.length === 0) return { ...node, [head.name]: child.filter((i) => !matches(i)) };
  return { ...node, [head.name]: child.map((i) => (matches(i) ? removeAt(i, rest) : i)) };
}

function matchesKey(item: unknown, field: string, value: string): boolean {
  if (!isObject(item)) return false;
  const v = item[field];
  if (typeof v === 'string' || typeof v === 'number') return String(v) === value;
  if (isObject(v) && typeof v.kind === 'string' && typeof v.id === 'string') {
    return `${v.kind}:${v.id}` === value;
  }
  return false;
}

export interface ReadWarning {
  readonly code: string;
  readonly paths: readonly string[];
  readonly params: Record<string, unknown>;
}

/**
 * Adapter read warnings that the Facet declares as `warning` findings become Plan warnings
 * (ADR-0311); the rest are diagnostics and stay in the stored translation only.
 */
export function splitReadWarnings(
  def: Pick<FacetDefinition<unknown>, 'key' | 'findingCodes'>,
  warnings: readonly ReadWarning[],
): {
  findings: { code: string; paths: string[]; params: Record<string, unknown> }[];
  diagnostics: ReadWarning[];
} {
  const findings: { code: string; paths: string[]; params: Record<string, unknown> }[] = [];
  const diagnostics: ReadWarning[] = [];
  for (const w of warnings) {
    const spec = def.findingCodes[w.code];
    if (spec?.kind === 'warning' && w.code.startsWith(`${def.key}.`)) {
      findings.push({ code: w.code, paths: [...w.paths], params: { ...w.params } });
    } else {
      diagnostics.push(w);
    }
  }
  return { findings, diagnostics };
}
