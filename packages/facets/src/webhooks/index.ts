/**
 * webhooks facet (FAC-WEB). Pure: no I/O, no provider vocabulary (GLO-002).
 *
 * The mapping from canonical events to the target's event names lives in the adapter (provider
 * docs); the facet works on canonical events. Decisions: docs/adr/0141-webhooks-facet.md.
 */
import {
  type CanonicalEvent,
  redactWebhookUrl,
  type Webhook,
  type Webhooks,
  webhookKey,
  webhooksFacet,
} from '@git-migrator/canonical';
import {
  type DocumentSchema,
  diffDocuments,
  type FacetDefinition,
  type FacetTaskRef,
  type FieldDecision,
  type FieldDiff,
  type Finding,
  itemSeg,
  joinFieldPath,
  seg,
  type TranslateContext,
  type TranslationResult,
} from '@git-migrator/core';

export const EVENT_DROPPED = 'webhooks.event-dropped';
export const RECREATE_MANUALLY = 'webhooks.recreate-manually';
export const SET_SECRET = 'webhooks.set-secret';
export const DUPLICATE_URL = 'webhooks.duplicate-url';

/**
 * FAC-WEB-001: the target's events are coarser, so a receiver gets a superset of these. Each is
 * `translated`; the others map one to one.
 */
export const COARSE_EVENTS: ReadonlySet<CanonicalEvent> = new Set<CanonicalEvent>([
  'cr.opened',
  'cr.updated',
  'cr.merged',
  'cr.declined',
  'cr.comment',
  'cr.approved',
  'cr.changes_requested',
  'build.status',
]);

function sortedEvents(events: readonly CanonicalEvent[]): CanonicalEvent[] {
  return [...new Set(events)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function hookPath(key: string, ...rest: string[]): string {
  return joinFieldPath('', itemSeg('hooks', 'key', key), ...rest.map(seg));
}

export function normalizeWebhooks(data: Webhooks): Webhooks {
  return { hooks: data.hooks.map((h) => ({ ...h, events: sortedEvents(h.events) })) };
}

// -- URL allowlist (FAC-WEB-002) ---------------------------------------------------------------

/** Characters that make a raw URL ambiguous between parsers: backslash, whitespace, controls. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const AMBIGUOUS_URL = /[\\\s\u0000-\u001f\u007f]/;

function parseUrl(value: string): URL | undefined {
  if (AMBIGUOUS_URL.test(value)) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Path glob: `*` stays inside a segment, `**` crosses segments, everything else is literal. */
function pathGlobToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i);
    if (ch === '*') {
      if (glob.charAt(i + 1) === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 's');
}

/** Host glob: a label of `*` matches exactly one label. `**` is not valid in a host. */
function hostGlobToRegExp(glob: string): RegExp | undefined {
  if (glob.includes('**')) return undefined;
  const labels = glob.split('.').map((label) =>
    label
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\-]/g, '\\$&'))
      .join('[^.]+'),
  );
  return new RegExp(`^${labels.join('\\.')}$`);
}

/**
 * Structural match of a hook URL against one allowlist pattern (FAC-WEB-002, ADR-0141). Both are
 * parsed as URLs: the scheme must be equal, the port equal once defaults are removed, the host
 * equal case-insensitively (`*` is one label), and the path must match the glob. The query and the
 * fragment are ignored. A hook URL with a backslash, whitespace or a control character, or one that
 * does not parse, never matches (fail closed).
 */
export function matchesPattern(url: string, pattern: string): boolean {
  const target = parseUrl(url);
  const rule = parseUrl(pattern);
  if (target === undefined || rule === undefined) return false;
  if (target.protocol !== rule.protocol || target.port !== rule.port) return false;
  const host = hostGlobToRegExp(rule.hostname);
  if (host === undefined || !host.test(target.hostname)) return false;
  return pathGlobToRegExp(rule.pathname).test(target.pathname);
}

export function matchesAllowlist(url: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(url, p));
}

/** `ctx.route.webhookAllowlist`: the Route's `WebhookAllowlistEntry` patterns. Malformed throws. */
export function routeWebhookAllowlist(route: TranslateContext['route']): string[] {
  const configured = route.webhookAllowlist;
  if (configured === undefined) return [];
  if (!Array.isArray(configured) || configured.some((p) => typeof p !== 'string' || p === '')) {
    throw new TypeError('route.webhookAllowlist must be an array of non-empty URL patterns');
  }
  return configured as string[];
}

/** Events the target can receive: `ctx.targetCaps.fields['/hooks/events']` = `only:<csv>`. */
function supportedEvents(ctx: TranslateContext): ReadonlySet<string> | undefined {
  const support = ctx.targetCaps.fields['/hooks/events'];
  if (support?.kind !== 'constrained' || !support.constraint.startsWith('only:')) return undefined;
  return new Set(support.constraint.slice('only:'.length).split(','));
}

// -- translate ---------------------------------------------------------------------------------

/** The finding code and policy key names of one hook-bearing facet (`webhooks`, `org-webhooks`). */
export interface HookSetCodes {
  readonly eventDropped: string;
  readonly recreateManually: string;
  readonly setSecret: string;
}

const WEBHOOK_CODES: HookSetCodes = {
  eventDropped: EVENT_DROPPED,
  recreateManually: RECREATE_MANUALLY,
  setSecret: SET_SECRET,
};

/**
 * The FAC-WEB translation of a list of hooks, shared with `org-webhooks` (FAC-END): allowlist,
 * event support, secret handling and the findings, under the facet's own codes.
 */
export function translateHookSet(
  sourceHooks: readonly Webhook[],
  ctx: TranslateContext,
  codes: HookSetCodes,
): { hooks: Webhook[]; decisions: FieldDecision[]; postTasks: Finding[] } {
  const allowlist = ctx.policies.webhookAllowlistEnabled ? routeWebhookAllowlist(ctx.route) : null;
  const supported = supportedEvents(ctx);
  const hooks: Webhook[] = [];
  const decisions: FieldDecision[] = [];
  const postTasks: Finding[] = [];

  for (const h of sourceHooks) {
    const events = sortedEvents(h.events).filter(
      (e) => supported === undefined || supported.has(e),
    );
    const dropped = supported !== undefined && events.length !== h.events.length;
    // A hook with nothing left to receive is not worth creating: the human decides (ADR-0141).
    const allowed =
      (allowlist === null || matchesAllowlist(h.url, allowlist)) &&
      !(dropped && events.length === 0);

    if (allowed) {
      // FAC-WEB-003: a hook with a secret is created inactive and without the secret.
      hooks.push({ ...h, events, active: h.hasSecret ? false : h.active });
      if (dropped) {
        decisions.push({
          path: hookPath(h.key, 'events'),
          fidelity: 'lossy',
          policyKey: codes.eventDropped,
          accepted: false,
        });
      } else if (events.some((e) => COARSE_EVENTS.has(e))) {
        decisions.push({
          path: hookPath(h.key, 'events'),
          fidelity: 'translated',
          accepted: false,
        });
      }
      if (h.hasSecret) {
        decisions.push({
          path: hookPath(h.key, 'active'),
          fidelity: 'translated',
          accepted: false,
          note: 'inactive until the secret is set',
        });
      }
    } else {
      postTasks.push({
        code: codes.recreateManually,
        paths: [hookPath(h.key)],
        params: { targetUrl: h.url, events },
      });
    }
    if (h.hasSecret) {
      postTasks.push({
        code: codes.setSecret,
        paths: [allowed ? hookPath(h.key, 'hasSecret') : hookPath(h.key)],
        // No full URL: it may carry the credential (ADR-0141).
        params: {
          key: h.key,
          targetUrlDisplay: redactWebhookUrl(h.url),
          activateAfterSecret: h.active,
        },
      });
    }
  }

  return { hooks, decisions, postTasks };
}

export function translateWebhooks(
  source: Webhooks,
  ctx: TranslateContext,
): TranslationResult<Webhooks> {
  const { hooks, decisions, postTasks } = translateHookSet(source.hooks, ctx, WEBHOOK_CODES);
  return {
    desired: { hooks },
    decisions,
    blockers: [],
    preTasks: [],
    postTasks,
    warnings: [],
  };
}

// -- duplicate URLs (ADR-0088) -------------------------------------------------------------------

export type RawWebhook = Omit<Webhook, 'key'>;

export interface DuplicateUrlGroup {
  readonly key: string;
  readonly count: number;
}

/**
 * For readers: providers allow several hooks with one URL, a canonical document does not
 * (ADR-0088). Merges hooks whose normalized URL is the same into one (events are united, `active`
 * and `hasSecret` hold if any hook has them, `verifyTls` holds only if all do) and reports each
 * group as a `webhooks.duplicate-url` warning. Throws `Error('invalid webhook url')` (without the URL) on an invalid URL.
 */
export function mergeDuplicateWebhooks(raw: readonly RawWebhook[]): {
  hooks: Webhook[];
  duplicates: DuplicateUrlGroup[];
  warnings: Finding[];
} {
  const groups = new Map<string, RawWebhook[]>();
  for (const h of raw) {
    let key: string;
    try {
      key = webhookKey(h.url);
    } catch {
      // Not the TypeError itself: its `input` property holds the raw URL.
      throw new Error('invalid webhook url');
    }
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const hooks: Webhook[] = [];
  const duplicates: DuplicateUrlGroup[] = [];
  const warnings: Finding[] = [];
  for (const [key, list] of groups) {
    // Order-independent: the smallest raw URL stands for the group.
    const url = list.map((h) => h.url).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))[0] as string;
    hooks.push({
      key,
      url,
      events: sortedEvents(list.flatMap((h) => h.events)),
      active: list.some((h) => h.active),
      hasSecret: list.some((h) => h.hasSecret),
      verifyTls: list.every((h) => h.verifyTls),
    });
    if (list.length > 1) {
      duplicates.push({ key, count: list.length });
      warnings.push({
        code: DUPLICATE_URL,
        paths: [hookPath(key)],
        params: { targetUrlDisplay: redactWebhookUrl(url), count: list.length },
      });
    }
  }
  return {
    hooks: hooks.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    duplicates,
    warnings,
  };
}

// -- compare -----------------------------------------------------------------------------------

const withoutUrl = (d: Webhooks) => ({ hooks: d.hooks.map(({ url: _url, ...rest }) => rest) });

/**
 * FAC-WEB-001/003. The `url` is implied by `key` and carries credentials, so it is not compared.
 * Events: a target receiving a superset of the desired events is equal. A hook with a secret is
 * desired inactive, but the human activates it after setting the secret, so its `active` is not
 * compared. Hooks only on the target are not drift (ADR-0141).
 */
export function compareHookSet(
  desiredHooks: readonly Webhook[],
  actualHooks: readonly Webhook[],
  schema: DocumentSchema,
): FieldDiff[] {
  const actualByKey = new Map(actualHooks.map((h) => [h.key, h]));
  const wanted = new Set(desiredHooks.map((h) => h.key));
  const effective: Webhooks = {
    hooks: desiredHooks.map((d) => {
      const a = actualByKey.get(d.key);
      if (a === undefined) return d;
      const covered = d.events.every((e) => a.events.includes(e));
      return {
        ...d,
        events: covered ? a.events : d.events,
        active: d.hasSecret && !d.active ? a.active : d.active,
      };
    }),
  };
  const comparable: Webhooks = { hooks: actualHooks.filter((h) => wanted.has(h.key)) };
  return diffDocuments(withoutUrl(effective), withoutUrl(comparable), schema);
}

export function compareWebhooks(desired: Webhooks, actual: Webhooks): FieldDiff[] {
  return compareHookSet(desired.hooks, actual.hooks, {
    collections: webhooksFacet.collections,
    sets: webhooksFacet.sets ?? [],
  });
}

// -- tasks -------------------------------------------------------------------------------------

function paramString(params: unknown, name: string): string | undefined {
  const v =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>)[name]
      : undefined;
  return typeof v === 'string' ? v : undefined;
}

function targetHook(task: FacetTaskRef, target: readonly Webhook[]): Webhook | undefined {
  let key = paramString(task.params, 'key');
  if (key === undefined) {
    const url = paramString(task.params, 'targetUrl');
    if (url === undefined) return undefined;
    try {
      key = webhookKey(url);
    } catch {
      return undefined;
    }
  }
  return target.find((h) => h.key === key);
}

/** FAC-WEB-002/003 completion. */
export function isHookSetTaskSatisfied(
  task: FacetTaskRef,
  target: readonly Webhook[],
  codes: HookSetCodes,
): boolean {
  const hook = targetHook(task, target);
  if (hook === undefined) return false;
  if (task.code === codes.setSecret) {
    // A hook that was inactive on the source stays inactive (activateAfterSecret: false).
    const activate = (task.params as { activateAfterSecret?: unknown }).activateAfterSecret;
    return hook.hasSecret && (hook.active || activate === false);
  }
  if (task.code === codes.recreateManually) {
    const events = (task.params as { events?: unknown }).events;
    return (
      Array.isArray(events) &&
      events.every((e) => typeof e === 'string' && hook.events.includes(e as CanonicalEvent))
    );
  }
  return false;
}

export function isWebhookTaskSatisfied(task: FacetTaskRef, target: Webhooks): boolean {
  return isHookSetTaskSatisfied(task, target.hooks, WEBHOOK_CODES);
}

export const webhooksDefinition: FacetDefinition<Webhooks> = {
  key: webhooksFacet.key,
  scope: webhooksFacet.scope,
  schemaVersion: webhooksFacet.schemaVersion,
  schema: webhooksFacet.schema,
  compareMode: 'full',
  collections: webhooksFacet.collections,
  sets: webhooksFacet.sets,
  dependsOn: [],
  inScope: true,
  normalize: normalizeWebhooks,
  translate: translateWebhooks,
  compare: (desired, actual) => compareWebhooks(desired, actual),
  isTaskSatisfied: (task, target) => isWebhookTaskSatisfied(task, target),
  findingCodes: {
    [RECREATE_MANUALLY]: { kind: 'post', completion: 'parity' },
    [SET_SECRET]: { kind: 'post', completion: 'parity' },
    'webhooks.accept-lossy': { kind: 'pre', completion: 'accept' },
    [DUPLICATE_URL]: { kind: 'warning' },
  },
  policyKeys: [EVENT_DROPPED],
};
