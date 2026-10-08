/**
 * Domain events (JOB-060): the payload of `NOTIFY gm_events`, the topics a client subscribes to, and
 * the mapping between the two. Pure: publishing and listening live in `packages/db`, fan-out and
 * SSE in `packages/api`.
 *
 * Events carry identifiers only. A client that receives one refetches through ZenStack or the API,
 * so permissions are enforced on the refetch, not on the event.
 */

/** The PostgreSQL channel every event is published on. */
export const EVENT_CHANNEL = 'gm_events';

/** NOTIFY payloads are limited to 8,000 bytes by PostgreSQL; JOB-060 keeps them at or below 7,000. */
export const MAX_EVENT_PAYLOAD_BYTES = 7000;

export const EVENT_TYPES = [
  'migration.updated',
  'run.updated',
  'run.log',
  'task.updated',
  'inventory.progress',
  'quota.updated',
  'invitation.updated',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The kinds of identifier an event can carry. */
export const EVENT_ID_KEYS = ['migration', 'run', 'task', 'endpoint', 'invitation'] as const;
export type EventIdKey = (typeof EVENT_ID_KEYS)[number];

export interface DomainEvent {
  readonly type: EventType;
  /** Identifiers of the things that changed, by kind. Never other data. */
  readonly ids: Readonly<Partial<Record<EventIdKey, string>>>;
  /** ISO 8601 instant at which the change was published. */
  readonly at: string;
}

/** What `list:*` topics exist: a client watches a whole list rather than one item. */
export const LIST_TOPICS = [
  'list:migrations',
  'list:runs',
  'list:tasks',
  'list:repositories',
  'list:invitations',
] as const;

/** Item topics have an identifier: `migration:<id>`. */
export const ITEM_TOPIC_KINDS = EVENT_ID_KEYS;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The most topics one subscription may name. */
export const MAX_TOPICS = 50;

const encoder = new TextEncoder();

export class EventEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventEncodingError';
  }
}

/** True for the exact output of `Date.prototype.toISOString` (`2026-01-01T00:00:00.000Z`). */
function isIsoInstant(text: string): boolean {
  const time = Date.parse(text);
  return !Number.isNaN(time) && new Date(time).toISOString() === text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a parsed value as a DomainEvent, or returns `undefined`. */
export function parseEvent(value: unknown): DomainEvent | undefined {
  if (!isRecord(value)) return undefined;
  const { type, ids, at } = value;
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
    return undefined;
  }
  if (typeof at !== 'string' || !isIsoInstant(at)) return undefined;
  if (!isRecord(ids)) return undefined;
  const out: Partial<Record<EventIdKey, string>> = {};
  for (const [key, id] of Object.entries(ids)) {
    if (!(EVENT_ID_KEYS as readonly string[]).includes(key)) return undefined;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return undefined;
    out[key as EventIdKey] = id;
  }
  return { type: type as EventType, ids: out, at };
}

/** The NOTIFY payload for `event`. Throws `EventEncodingError` when it is invalid or too large. */
export function encodeEvent(event: DomainEvent): string {
  const checked = parseEvent(event);
  if (!checked) throw new EventEncodingError('not a valid domain event');
  const text = JSON.stringify({ type: checked.type, ids: checked.ids, at: checked.at });
  if (encoder.encode(text).length > MAX_EVENT_PAYLOAD_BYTES) {
    throw new EventEncodingError('event payload exceeds the NOTIFY limit');
  }
  return text;
}

/** Parses a NOTIFY payload; `undefined` for anything that is not a valid event. */
export function decodeEvent(text: string): DomainEvent | undefined {
  if (encoder.encode(text).length > MAX_EVENT_PAYLOAD_BYTES) return undefined;
  try {
    return parseEvent(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * The topics an event is delivered on. A change to a Run also concerns its Migration, and every
 * change that shows in a list is also published on that list.
 */
export function topicsForEvent(event: DomainEvent): string[] {
  const { migration, run, task, endpoint, invitation } = event.ids;
  const topics: string[] = [];
  const item = (kind: EventIdKey, id: string | undefined) => {
    if (id !== undefined) topics.push(`${kind}:${id}`);
  };
  switch (event.type) {
    case 'migration.updated':
      item('migration', migration);
      topics.push('list:migrations');
      break;
    case 'run.updated':
      item('run', run);
      item('migration', migration);
      topics.push('list:runs', 'list:migrations');
      break;
    case 'run.log':
      item('run', run);
      break;
    case 'task.updated':
      item('task', task);
      item('migration', migration);
      topics.push('list:tasks');
      break;
    case 'inventory.progress':
      item('endpoint', endpoint);
      topics.push('list:repositories');
      break;
    case 'quota.updated':
      topics.push('quota');
      break;
    case 'invitation.updated':
      item('invitation', invitation);
      topics.push('list:invitations');
      break;
  }
  return topics;
}

/** True for `quota`, a `list:*` topic that exists, or `<kind>:<id>` with a known kind. */
export function isValidTopic(topic: string): boolean {
  if (topic === 'quota') return true;
  if ((LIST_TOPICS as readonly string[]).includes(topic)) return true;
  const colon = topic.indexOf(':');
  if (colon < 0) return false;
  return (
    (ITEM_TOPIC_KINDS as readonly string[]).includes(topic.slice(0, colon)) &&
    ID_PATTERN.test(topic.slice(colon + 1))
  );
}

export type TopicListResult =
  | { readonly ok: true; readonly topics: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Parses the `topics` query parameter: comma separated, de-duplicated, 1 to `MAX_TOPICS` valid topics. */
export function parseTopicList(text: string | undefined): TopicListResult {
  const topics = [
    ...new Set(
      (text ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
    ),
  ];
  if (topics.length === 0) return { ok: false, reason: 'at least one topic is required' };
  if (topics.length > MAX_TOPICS) {
    return { ok: false, reason: `at most ${MAX_TOPICS} topics may be named` };
  }
  const bad = topics.find((t) => !isValidTopic(t));
  if (bad !== undefined) return { ok: false, reason: 'unknown topic' };
  return { ok: true, topics };
}
