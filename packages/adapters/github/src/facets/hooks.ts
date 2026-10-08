/** webhooks (FAC-WEB) and org-webhooks drivers; one implementation over two base paths. */
import type { FacetDriver, MutationRecord } from '@git-migrator/adapter-sdk';
import {
  CANONICAL_EVENTS,
  type CanonicalEvent,
  redactWebhookUrl,
  type Webhook,
  webhookKey,
} from '@git-migrator/canonical';
import { Collector, type Gh, type Json, obj, repoPath, str } from '../gh.ts';
import {
  type DriverDeps,
  ghOf,
  itemPath,
  mutation,
  orgTarget,
  repoTarget,
  sortBy,
} from './common.ts';

/** Canonical event to the GitHub events that deliver it (FAC-WEB-001; GitHub's are coarser). */
export const GITHUB_EVENTS: Readonly<Record<CanonicalEvent, readonly string[]>> = {
  push: ['push'],
  'cr.opened': ['pull_request'],
  'cr.updated': ['pull_request'],
  'cr.merged': ['pull_request'],
  'cr.declined': ['pull_request'],
  'cr.comment': ['pull_request_review_comment', 'issue_comment'],
  'cr.approved': ['pull_request_review'],
  'cr.changes_requested': ['pull_request_review'],
  'build.status': ['status', 'check_run'],
  'repo.updated': ['repository'],
  'repo.fork': ['fork'],
  'issue.any': ['issues'],
};

export function toGithubEvents(events: readonly CanonicalEvent[]): string[] {
  return [...new Set(events.flatMap((e) => GITHUB_EVENTS[e]))].sort();
}

/** Events a GitHub hook delivers, as canonical events (the covering set; `*` is everything). */
export function fromGithubEvents(events: readonly string[]): CanonicalEvent[] {
  if (events.includes('*')) return [...CANONICAL_EVENTS].sort();
  const have = new Set(events);
  return CANONICAL_EVENTS.filter((c) => GITHUB_EVENTS[c].some((g) => have.has(g))).sort();
}

interface RawHook {
  id: number;
  url: string;
  events: CanonicalEvent[];
  active: boolean;
  hasSecret: boolean;
  verifyTls: boolean;
}

function rawOf(h: Json): RawHook | undefined {
  const config = obj(h.config);
  const url = str(config.url);
  if (typeof h.id !== 'number' || url === '') return undefined;
  return {
    id: h.id,
    url,
    events: fromGithubEvents(Array.isArray(h.events) ? (h.events as string[]) : []),
    active: h.active !== false,
    hasSecret: config.secret !== undefined && config.secret !== null && config.secret !== '',
    verifyTls: String(config.insecure_ssl ?? '0') === '0',
  };
}

/**
 * Providers allow several hooks with one URL, a canonical document does not (ADR-0088). Merges them
 * as the facet package does (events united; `active` and `hasSecret` if any; `verifyTls` only if
 * all) and reports each group as `webhooks.duplicate-url` with a redacted URL.
 */
export function mergeHooks(
  raw: readonly RawHook[],
  collector: Collector,
  prefix: string,
): { hooks: Webhook[]; groups: Map<string, RawHook[]> } {
  const groups = new Map<string, RawHook[]>();
  for (const h of raw) {
    let key: string;
    try {
      key = webhookKey(h.url);
    } catch {
      collector.warn(`${prefix}.invalid-url`, [], {});
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  const hooks: Webhook[] = [];
  for (const [key, list] of groups) {
    const url = list.map((h) => h.url).sort()[0] as string;
    hooks.push({
      key,
      url,
      events: [...new Set(list.flatMap((h) => h.events))].sort() as CanonicalEvent[],
      active: list.some((h) => h.active),
      hasSecret: list.some((h) => h.hasSecret),
      verifyTls: list.every((h) => h.verifyTls),
    });
    if (list.length > 1) {
      collector.warn(`${prefix}.duplicate-url`, [itemPath('hooks', 'key', key)], {
        targetUrlDisplay: redactWebhookUrl(url),
        count: list.length,
      });
    }
  }
  return { hooks: sortBy(hooks, (h) => h.key), groups };
}

async function readHooks(gh: Gh, base: string, collector: Collector, prefix: string) {
  const list = await gh.list<Json>(`${base}/hooks`);
  return mergeHooks(
    list.flatMap((h) => rawOf(h) ?? []),
    collector,
    prefix,
  );
}

function hookDriver(
  facetKey: 'webhooks' | 'org-webhooks',
  baseOf: (deps: DriverDeps, target: Parameters<typeof repoTarget>[0]) => string,
): (deps: DriverDeps) => FacetDriver<{ hooks: Webhook[] }> {
  return (deps) => ({
    async read(ctx, target) {
      const collector = new Collector();
      // Hook URLs can carry credentials and body stripping cannot recognise them, so the hook
      // list is deliberately not captured (ADP-061, ADR-0231).
      const { hooks } = await readHooks(
        ghOf(ctx),
        baseOf(deps, target),
        collector,
        facetKey === 'webhooks' ? 'webhooks' : 'org-webhooks',
      );
      return collector.result({ hooks });
    },

    async *apply(ctx, target, desired) {
      const gh = ghOf(ctx);
      const base = baseOf(deps, target);
      const collector = new Collector();
      const { hooks: have, groups } = await readHooks(gh, base, collector, facetKey);
      const haveByKey = new Map(have.map((h) => [h.key, h]));
      for (const hook of desired.hooks) {
        const path = itemPath('hooks', 'key', hook.key);
        const existing = haveByKey.get(hook.key);
        const events = toGithubEvents(hook.events);
        if (!existing) {
          // FAC-WEB-003/004: JSON payloads; a hook with a secret is created inactive and without it.
          const created = await gh.send<Json>('POST', `${base}/hooks`, {
            name: 'web',
            active: hook.hasSecret ? false : hook.active,
            events,
            config: {
              url: hook.url,
              content_type: 'json',
              insecure_ssl: hook.verifyTls ? '0' : '1',
            },
          });
          yield mutation(
            facetKey,
            'create',
            { kind: 'webhook', id: created.id, key: hook.key },
            [path],
            null,
            { ...hook, url: redactWebhookUrl(hook.url) },
          );
          continue;
        }
        const targetHook = (groups.get(hook.key) ?? [])[0];
        if (!targetHook) continue;
        const missingEvents = hook.events.some((e) => !existing.events.includes(e));
        // A hook with a secret waits for a human to set the secret and activate it (FAC-WEB-003).
        // Never activate a target hook that has no secret, even on a later apply.
        const activateWithoutSecret = hook.hasSecret && !existing.hasSecret && hook.active;
        const activeDiffers =
          hook.active !== existing.active &&
          !(existing.hasSecret && hook.active === false) &&
          !activateWithoutSecret;
        const patch: Json = {};
        if (missingEvents)
          patch.events = toGithubEvents([...new Set([...existing.events, ...hook.events])]);
        if (activeDiffers) patch.active = hook.active;
        const paths: string[] = [];
        if (missingEvents) paths.push(`${path}/events`);
        if (activeDiffers) paths.push(`${path}/active`);
        if (Object.keys(patch).length > 0) {
          await gh.send('PATCH', `${base}/hooks/${targetHook.id}`, patch);
        }
        if (hook.verifyTls !== existing.verifyTls) {
          await gh.send('PATCH', `${base}/hooks/${targetHook.id}/config`, {
            insecure_ssl: hook.verifyTls ? '0' : '1',
          });
          paths.push(`${path}/verifyTls`);
        }
        if (paths.length > 0) {
          const record: MutationRecord = mutation(
            facetKey,
            'update',
            { kind: 'webhook', id: targetHook.id, key: hook.key },
            paths,
            { events: existing.events, active: existing.active, verifyTls: existing.verifyTls },
            {
              events: hook.events,
              active: activeDiffers ? hook.active : existing.active,
              verifyTls: hook.verifyTls,
            },
          );
          yield record;
        }
      }
    },
  });
}

export const webhooksDriver = hookDriver('webhooks', (deps, target) =>
  repoPath(deps.org, repoTarget(target).slug),
);
export const orgWebhooksDriver = hookDriver(
  'org-webhooks',
  (_deps, target) => `/orgs/${orgTarget(target)}`,
);
