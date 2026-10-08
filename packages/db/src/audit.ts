import { type AnyPlugin, definePlugin, type JsonValue } from '@zenstackhq/orm';
import { schema } from './generated/schema.ts';

/** The id of the audit plugin on a `forActor` client (AUTH-022). */
export const AUDIT_PLUGIN_ID = 'git-migrator-audit';

/** The `AuditEvent.action` of an RPC mutation: `rpc.<model_snake>.<create|update|delete>` (ADR-0201). */
export const rpcAuditAction = (model: string, action: 'create' | 'update' | 'delete'): string =>
  `rpc.${snake(model)}.${action}`;

/** The shown value of a field that must not be recorded. */
export const AUDIT_REDACTED = '[redacted]';
/** Longest string (or serialized JSON) a diff records for one field. */
export const AUDIT_MAX_VALUE_LENGTH = 2000;

const SENSITIVE_FIELD = /secret|token|password|passwd|credential|authorization|api_?key|hash/i;
/** Bookkeeping columns that are not part of what the Actor changed. */
const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set(['createdAt', 'updatedAt']);

type Row = Record<string, unknown>;
type MutationAction = 'create' | 'update' | 'delete';

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Column name (`target_date`) to field name (`targetDate`), per model, from `@map`. */
const COLUMN_TO_FIELD = new Map<string, Map<string, string>>();
for (const [model, def] of Object.entries(schema.models)) {
  const map = new Map<string, string>();
  for (const [field, fieldDef] of Object.entries(
    (
      def as {
        fields: Record<string, { attributes?: readonly { name: string; args?: unknown[] }[] }>;
      }
    ).fields,
  )) {
    const mapAttr = fieldDef.attributes?.find((a) => a.name === '@map');
    const arg = mapAttr?.args?.[0] as { value?: { value?: unknown } } | undefined;
    const column = arg?.value?.value;
    if (typeof column === 'string') map.set(column, field);
  }
  COLUMN_TO_FIELD.set(model, map);
}

function fieldNameOf(model: string, key: string): string {
  return COLUMN_TO_FIELD.get(model)?.get(key) ?? key;
}

/** Replaces the value of every key that looks like a secret, at any depth (bounded). */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[too deep]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_FIELD.test(key) ? AUDIT_REDACTED : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** A value as it is recorded: JSON-safe, bounded, and never a secret. */
export function auditValue(field: string, value: unknown): unknown {
  if (SENSITIVE_FIELD.test(field)) return AUDIT_REDACTED;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (typeof value === 'string') {
    return value.length > AUDIT_MAX_VALUE_LENGTH ? `[omitted: ${value.length} characters]` : value;
  }
  const text = safeJson(scrub(value));
  if (text.length > AUDIT_MAX_VALUE_LENGTH) return `[omitted: ${text.length} characters]`;
  return JSON.parse(text) as unknown;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    ) as string;
  } catch {
    return '"[unserializable]"';
  }
}

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return safeJson(a) === safeJson(b);
  }
  return Object.is(a, b);
};

const named = (model: string, row: Row): Row => {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) out[fieldNameOf(model, key)] = value;
  return out;
};

/** The redacted diff of one row: `{ field: { from, to } }` (`from` absent on create, `to` on delete). */
export function auditChanges(
  action: MutationAction,
  before: Row | undefined,
  after: Row | undefined,
): Record<string, { from?: unknown; to?: unknown }> {
  const changes: Record<string, { from?: unknown; to?: unknown }> = {};
  const fields = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const field of [...fields].sort()) {
    if (BOOKKEEPING_FIELDS.has(field)) continue;
    const from = before?.[field];
    const to = after?.[field];
    if (action === 'update' && same(from, to)) continue;
    changes[field] = {
      ...(action === 'create' ? {} : { from: auditValue(field, from) }),
      ...(action === 'delete' ? {} : { to: auditValue(field, to) }),
    };
  }
  return changes;
}

function subjectId(model: string, row: Row): string {
  const def = schema.models[model as keyof typeof schema.models] as unknown as {
    idFields: readonly string[];
  };
  return def.idFields.map((f) => String(row[f])).join(':');
}

/**
 * The ZenStack plugin behind AUTH-022 for RPC mutations. It is installed on the policy-enforcing
 * client only, so every mutation made through `forActor` (the RPC mount) writes one `AuditEvent`
 * per affected row, with the Actor, `rpc.<model>.<action>`, the row as subject and a redacted
 * diff. It runs inside the transaction of the mutation (`runAfterMutationWithinTransaction`), so a
 * mutation and its audit event commit or roll back together, and the write runs as the
 * mutating Actor, because inside a transaction ZenStack keeps one plugin chain (ADR-0201). Reads are not
 * audited. Mutations made by this plugin do not trigger it again.
 */
/**
 * The Actor id behind a mutation. Without one the audit event cannot be written, so this throws
 * and the mutation rolls back: an unattributed write must never commit unaudited (fail closed).
 */
export function auditActorId(client: { $auth?: unknown }): string {
  const id = (client.$auth as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error('refusing an RPC mutation without an Actor: it cannot be audited');
  }
  return id;
}

/**
 * Rows a delete clears through a database `ON DELETE SET NULL`, which fires no hook of its own.
 * Their ids go into the delete event (ADR-0202): model, the model whose rows are cleared, the
 * foreign key, and the key under which the ids are recorded.
 */
const CLEARED_BY_DELETE: Readonly<Record<string, { child: 'migration'; fk: string; key: string }>> =
  { Wave: { child: 'migration', fk: 'waveId', key: 'clearedMigrationIds' } };

export function createAuditPlugin(): AnyPlugin {
  /** Per mutation (by query id): subject id to the ids of rows its delete will clear. */
  const cleared = new Map<unknown, Map<string, string[]>>();
  return definePlugin(schema, {
    id: AUDIT_PLUGIN_ID,
    name: 'git-migrator audit',
    onEntityMutation: {
      runAfterMutationWithinTransaction: true,
      async beforeEntityMutation({ model, action, client, queryId, loadBeforeMutationEntities }) {
        if (model === 'AuditEvent' || action === 'create') return;
        const rows = (await loadBeforeMutationEntities()) ?? [];
        const rule = CLEARED_BY_DELETE[model];
        if (action !== 'delete' || !rule || rows.length === 0) return;
        const parents = rows.map((row) => subjectId(model, named(model, row)));
        const children = (await (
          client as unknown as Record<string, { findMany(a: unknown): Promise<Row[]> }>
        )[rule.child]?.findMany({
          where: { [rule.fk]: { in: parents } },
          select: { id: true, [rule.fk]: true },
        })) as Row[];
        const byParent = new Map<string, string[]>();
        for (const child of children ?? []) {
          const parent = String(child[rule.fk]);
          byParent.set(parent, [...(byParent.get(parent) ?? []), String(child.id)]);
        }
        cleared.set(queryId, byParent);
      },
      async afterEntityMutation({
        model,
        queryId,
        action,
        client,
        loadAfterMutationEntities,
        beforeMutationEntities,
      }) {
        if (model === 'AuditEvent') return;
        const before = (beforeMutationEntities ?? []).map((row) => named(model, row));
        const after = ((await loadAfterMutationEntities()) ?? []).map((row) => named(model, row));
        const rows = action === 'delete' ? before : after;
        const actorId = auditActorId(client);
        const clearedRows = cleared.get(queryId);
        cleared.delete(queryId);
        const rule = CLEARED_BY_DELETE[model];
        for (const row of rows) {
          const id = subjectId(model, row);
          const prior = before.find((b) => subjectId(model, b) === id);
          await client.auditEvent.create({
            data: {
              actorId,
              action: rpcAuditAction(model, action),
              subjectType: snake(model),
              subjectId: id,
              data: {
                via: 'rpc',
                ...(rule && clearedRows ? { [rule.key]: clearedRows.get(id) ?? [] } : {}),
                changes: auditChanges(
                  action,
                  prior,
                  action === 'delete' ? undefined : row,
                ) as unknown as JsonValue,
              },
            },
          });
        }
      },
    },
  }) as unknown as AnyPlugin;
}
