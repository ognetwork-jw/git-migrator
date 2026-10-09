/** The GitHub EndpointConnection: inventory, repositories, refs, LFS, invitations (ADP-010). */

import type { EndpointRuntime } from '@git-migrator/adapter-sdk';
import {
  type AdapterContext,
  AdapterError,
  type CreateRepositorySpec,
  type EndpointConnection,
  type GitAccess,
  type GroupRecord,
  type IdentityRecord,
  type InvitationWriter,
  type MutationRecord,
  type NamespaceRecord,
  type NamespaceRef,
  type Page,
  type ProviderLimits,
  type RepositoryRecord,
  type RepositoryRef,
} from '@git-migrator/adapter-sdk';
import type { InstallationTokenCache } from './auth.ts';
import { createChangeRequestWriter } from './change-requests.ts';
import { PROVIDER, parseConfig, parseCredential } from './config.ts';
import { buildDrivers } from './facets/index.ts';
import { encodePath, Gh, type Json, obj, repoPath, str } from './gh.ts';
import { buildClients } from './http.ts';

export const LIMITS: ProviderLimits = {
  maxBlobBytes: 100 * 1024 * 1024,
  maxPushBytes: 2 * 1024 * 1024 * 1024,
  repositoryName: { maxLength: 100, pattern: /^[A-Za-z0-9._-]+$/, caseInsensitiveUnique: true },
  hiddenRefPrefixes: ['refs/pull/'],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const OID = /^[0-9a-f]{64}$/;
/** The provider's words for the organization's daily invitation cap (provider body message only). */
const INVITATION_CAP = /invitation.*(limit|exceed)|exceeded.*invit/i;

/** `{ [key]: Date }` for a valid ISO timestamp, nothing otherwise. */
function timestamp<K extends string>(key: K, value: unknown): { [P in K]?: Date } {
  if (typeof value !== 'string') return {};
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? {} : ({ [key]: at } as { [P in K]?: Date });
}

/**
 * The provider's body message of a failed request. AdapterError messages read
 * `METHOD <url>: <detail>`, so the request prefix is cut off before any text matching.
 */
function providerDetail(error: AdapterError): string {
  const prefix = error.request ? `${error.request.method} ${error.request.url}: ` : '';
  return prefix !== '' && error.message.startsWith(prefix)
    ? error.message.slice(prefix.length)
    : '';
}

function repoRecord(r: Json, org: string): RepositoryRecord {
  const name = str(r.name);
  return {
    providerId: str(r.node_id),
    namespace: { providerId: '', slug: org },
    slug: name,
    name,
    fullPath: str(r.full_name) || `${org}/${name}`,
    isPrivate: r.private !== false,
    ...(typeof r.size === 'number' ? { sizeBytes: r.size * 1024 } : {}),
    defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : null,
    ...(typeof r.updated_at === 'string' ? { providerUpdatedAt: new Date(r.updated_at) } : {}),
    ...(typeof r.created_at === 'string' ? { createdAt: new Date(r.created_at) } : {}),
  };
}

function cursorPage(cursor: string | undefined): number {
  const n = Number(cursor ?? '1');
  return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : 1;
}

async function pool<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

export async function connectGitHub(
  endpoint: EndpointRuntime,
  ctx: AdapterContext,
  cache: InstallationTokenCache,
  now: () => Date,
  migrationUrl?: (repo: RepositoryRef) => string | undefined,
): Promise<EndpointConnection> {
  const config = parseConfig(endpoint.config);
  const credential = parseCredential(endpoint.credential);
  const clients = buildClients({
    endpointId: endpoint.id,
    accountKey: endpoint.accountKey,
    baseUrl: endpoint.baseUrl,
    config,
    credential,
    ctx,
    cache,
    now,
  });
  const org = config.org;
  const gh = () => new Gh(clients.api, { pool: ctx.pool, signal: ctx.signal });
  let namespaceId: string | undefined;
  const orgInfo = async (): Promise<Json> => {
    const body = obj(await gh().get(`/orgs/${org}`));
    namespaceId = String(body.id);
    return body;
  };
  const withNamespace = (r: RepositoryRecord): RepositoryRecord => ({
    ...r,
    namespace: { providerId: namespaceId ?? '', slug: org },
  });
  const ownerOf = (ref: { namespace: NamespaceRef }) => ref.namespace.slug || org;

  const access: GitAccess = {
    remoteUrl: (repo) =>
      `${config.gitBaseUrl.replace(/\/$/, '')}/${ownerOf(repo)}/${repo.slug}.git`,
    credential: async () => {
      const t = await clients.token();
      return { username: 'x-access-token', password: t.token, expiresAt: t.expiresAt };
    },
  };

  const changeRequests = createChangeRequestWriter(gh, org, migrationUrl);
  const drivers = buildDrivers({ org, access, changeRequests });

  const invitations: InvitationWriter = {
    async invite(req) {
      const teamIds = req.teamIds.map((id) => Number(id));
      if (teamIds.some((n) => !Number.isSafeInteger(n))) {
        throw new AdapterError({
          code: 'invalid',
          provider: PROVIDER,
          message: 'Team ids must be numeric',
        });
      }
      try {
        const res = obj(
          await gh().send('POST', `/orgs/${org}/invitations`, {
            email: req.email,
            role: 'direct_member',
            team_ids: teamIds,
          }),
        );
        return { providerInvitationId: String(res.id) };
      } catch (error) {
        // AUTH-060: a daily invitation cap leaves the rest selected and retries 24 h later. Only a
        // 422 whose provider body names the cap is rewritten; a rate limit (429, 403 secondary) keeps
        // the SDK's own retryAt, and the match never sees the request URL that the message carries.
        if (
          error instanceof AdapterError &&
          error.request?.status === 422 &&
          error.code !== 'rate_limited' &&
          INVITATION_CAP.test(providerDetail(error))
        ) {
          throw new AdapterError({
            code: 'rate_limited',
            provider: PROVIDER,
            message: 'The organization invitation limit was reached',
            retryAfterMs: DAY_MS,
            retryAt: new Date(now().getTime() + DAY_MS),
            ...(error.request ? { request: error.request } : {}),
          });
        }
        // A lost response: the invitation may exist already. Return it instead of failing (AUTH-060).
        if (error instanceof AdapterError && error.request?.status === 422) {
          const pending = await invitations.listPending();
          const hit = pending.find((p) => p.email?.toLowerCase() === req.email.toLowerCase());
          if (hit) return { providerInvitationId: hit.providerInvitationId };
        }
        throw error;
      }
    },
    async listPending() {
      const list = await gh().list<Json>(`/orgs/${org}/invitations`);
      return list.map((i) => ({
        providerInvitationId: String(i.id),
        ...(typeof i.email === 'string' ? { email: i.email } : {}),
        ...(typeof i.login === 'string' ? { inviteeLogin: i.login } : {}),
        ...timestamp('createdAt', i.created_at),
      }));
    },
    async cancel(providerInvitationId) {
      if (!/^\d{1,18}$/.test(providerInvitationId)) {
        throw new AdapterError({
          code: 'invalid',
          provider: PROVIDER,
          message: 'Invitation ids must be numeric',
        });
      }
      try {
        await gh().send('DELETE', `/orgs/${org}/invitations/${providerInvitationId}`);
        return { cancelled: true };
      } catch (error) {
        if (error instanceof AdapterError && error.code === 'not_found') {
          return { cancelled: false };
        }
        throw error;
      }
    },
    async listFailed() {
      const list = await gh().list<Json>(`/orgs/${org}/failed_invitations`);
      return list.map((i) => ({
        providerInvitationId: String(i.id),
        ...(typeof i.email === 'string' ? { email: i.email } : {}),
        reason: str(i.failed_reason) || 'failed',
        ...timestamp('createdAt', i.created_at),
        ...timestamp('failedAt', i.failed_at),
      }));
    },
  };

  return {
    http: clients.api,
    git: access,
    limits: LIMITS,
    facets: drivers,
    changeRequests,
    invitations,
    org: {
      async seatInfo() {
        const plan = obj(obj(await gh().get(`/orgs/${org}`)).plan);
        return {
          ...(typeof plan.seats === 'number' ? { total: plan.seats } : {}),
          ...(typeof plan.filled_seats === 'number' ? { filled: plan.filled_seats } : {}),
        };
      },
    },

    inventory: {
      async listNamespaces() {
        const o = await orgInfo();
        const record: NamespaceRecord = {
          providerId: String(o.id),
          kind: 'organization',
          slug: str(o.login) || org,
          name: str(o.name) || str(o.login) || org,
        };
        return { items: [record] };
      },

      async listRepositories(ns, cursor) {
        if (namespaceId === undefined) await orgInfo();
        const page = cursorPage(cursor);
        // The installation's repositories: exactly what the App can read (`/orgs/{org}/repos` is not used).
        const res = await gh().page<Json>(
          '/installation/repositories',
          page,
          {},
          (b) => obj(b).repositories,
        );
        return {
          items: res.items.map((r) => withNamespace(repoRecord(r, ns.slug))),
          ...(res.next !== undefined ? { nextCursor: String(res.next) } : {}),
        } satisfies Page<RepositoryRecord>;
      },

      async getRepository(ref) {
        const body = await gh().getOrNull<Json>(repoPath(ownerOf(ref), ref.slug));
        if (namespaceId === undefined) await orgInfo();
        return body ? withNamespace(repoRecord(body, ownerOf(ref))) : null;
      },

      async findRepository(ns, name) {
        const body = await gh().getOrNull<Json>(repoPath(ns.slug, name));
        if (namespaceId === undefined) await orgInfo();
        return body ? withNamespace(repoRecord(body, ns.slug)) : null;
      },

      async listIdentities(cursor) {
        // Cursor `m:<page>` walks members, `o:<page>` outside collaborators.
        const [stage, raw] = (cursor ?? 'm:1').split(':');
        const kind = stage === 'o' ? 'o' : 'm';
        const page = cursorPage(raw);
        const path = kind === 'm' ? `/orgs/${org}/members` : `/orgs/${org}/outside_collaborators`;
        const res = await gh().page<Json>(path, page);
        const items = await pool(res.items, 4, async (u): Promise<IdentityRecord> => {
          const login = str(u.login);
          const profile = obj(await gh().getOrNull(`/users/${encodeURIComponent(login)}`));
          const email = str(profile.email);
          return {
            providerId: String(u.id),
            login,
            ...(str(profile.name) ? { displayName: str(profile.name) } : {}),
            ...(email ? { email, emailSource: 'provider-public' } : {}),
            kind: u.type === 'Bot' ? 'bot' : 'user',
            isMember: kind === 'm',
          };
        });
        const nextCursor =
          res.next !== undefined ? `${kind}:${res.next}` : kind === 'm' ? 'o:1' : undefined;
        return { items, ...(nextCursor ? { nextCursor } : {}) };
      },

      async listGroups(cursor) {
        const res = await gh().page<Json>(`/orgs/${org}/teams`, cursorPage(cursor));
        const items = await pool(res.items, 4, async (t): Promise<GroupRecord> => {
          const members = await gh().list<Json>(`/orgs/${org}/teams/${str(t.slug)}/members`);
          return {
            providerId: String(t.id),
            slug: str(t.slug),
            name: str(t.name) || str(t.slug),
            memberProviderIds: members.flatMap((m) =>
              typeof m.id === 'number' ? [String(m.id)] : [],
            ),
          };
        });
        return { items, ...(res.next !== undefined ? { nextCursor: String(res.next) } : {}) };
      },
    },

    repositories: {
      async create(ns: NamespaceRef, spec: CreateRepositorySpec) {
        const body = obj(
          await gh().send('POST', `/orgs/${ns.slug}/repos`, {
            name: spec.name,
            description: spec.description,
            private: spec.visibility === 'private',
            auto_init: false,
          }),
        );
        if (namespaceId === undefined) await orgInfo();
        return withNamespace(repoRecord(body, ns.slug));
      },
      async delete(ref: RepositoryRef) {
        // 403 (Administration: write missing, or the organization forbids deletion) stays a
        // `forbidden` AdapterError; the Run fails with guidance (LIF-077).
        // Never delete whatever now holds the name: a renamed and re-created repository is a
        // different one (LIF-077).
        // Without the provider id there is nothing to prove the name still holds our repository.
        if (ref.providerId === '') {
          throw new AdapterError({
            code: 'invalid',
            provider: PROVIDER,
            message: 'Deleting a repository needs its provider id; not deleting it',
          });
        }
        const current = obj(await gh().get(repoPath(ownerOf(ref), ref.slug)));
        if (str(current.node_id) !== ref.providerId) {
          throw new AdapterError({
            code: 'conflict',
            provider: PROVIDER,
            message:
              'The repository with this name is not the one that was created; not deleting it',
          });
        }
        await gh().send('DELETE', repoPath(ownerOf(ref), ref.slug));
      },
      async isEmpty(ref: RepositoryRef) {
        // Empty means no refs at all, branches and tags alike. A missing repository throws
        // `not_found`; GitHub answers 409 for a repository without any commit.
        const client = gh();
        const base = repoPath(ownerOf(ref), ref.slug);
        for (const kind of ['heads', 'tags']) {
          try {
            const refs = await client.get<unknown>(`${base}/git/matching-refs/${kind}`, {
              per_page: 1,
            });
            if (Array.isArray(refs) && refs.length > 0) return false;
          } catch (error) {
            if (error instanceof AdapterError && error.code === 'conflict') return true;
            throw error;
          }
        }
        return true;
      },
    },

    refs: {
      async setDefaultBranch(ref, branch) {
        const client = gh();
        const base = repoPath(ownerOf(ref), ref.slug);
        const before = str(obj(await client.get(base)).default_branch);
        if (before !== branch) await client.send('PATCH', base, { default_branch: branch });
        // Nothing changed: the record says so (`noop`, before === after) rather than pretending to a
        // change. The signature returns one record, so it is kept; `noop` records are never undone.
        const unchanged = before === branch;
        const record: MutationRecord = {
          facetKey: 'git-refs',
          action: 'update',
          resourceRef: {
            kind: 'default-branch',
            repository: ref.slug,
            ...(unchanged ? { noop: true } : {}),
          },
          paths: ['/defaultBranch'],
          before: unchanged ? branch : before || null,
          after: branch,
        };
        return record;
      },
      async compare(ref, base, head) {
        const res = obj(
          await gh().get(
            `${repoPath(ownerOf(ref), ref.slug)}/compare/${encodePath(base)}...${encodePath(head)}`,
            { per_page: 1 },
          ),
        );
        const status = str(res.status);
        if (
          status === 'identical' ||
          status === 'ahead' ||
          status === 'behind' ||
          status === 'diverged'
        ) {
          return status;
        }
        throw new AdapterError({
          code: 'invalid',
          provider: PROVIDER,
          message: 'Unknown compare status',
        });
      },
    },

    lfs: {
      async missing(ref, oids) {
        const bad = oids.find((o) => !OID.test(o));
        if (bad !== undefined) {
          throw new AdapterError({
            code: 'invalid',
            provider: PROVIDER,
            message: 'Not a valid LFS object id',
          });
        }
        const missing = new Set<string>();
        const unique = [...new Set(oids)];
        for (let i = 0; i < unique.length; i += 100) {
          const chunk = unique.slice(i, i + 100);
          const res = await clients.lfs.request<{
            objects?: { oid?: string; error?: { code?: number } }[];
          }>({
            method: 'POST',
            path: `/${ownerOf(ref)}/${ref.slug}.git/info/lfs/objects/batch`,
            headers: { 'content-type': 'application/vnd.git-lfs+json' },
            json: {
              operation: 'download',
              transfers: ['basic'],
              objects: chunk.map((oid) => ({ oid, size: 0 })),
            },
            pool: ctx.pool,
            signal: ctx.signal,
            retry: false,
          });
          const answered = new Set<string>();
          for (const o of res.body?.objects ?? []) {
            if (typeof o.oid !== 'string') continue;
            answered.add(o.oid);
            // Any per-object error means the object cannot be downloaded: count it as missing.
            if (o.error !== undefined) missing.add(o.oid);
          }
          // An object the server did not answer for is not known to exist.
          for (const oid of chunk) if (!answered.has(oid)) missing.add(oid);
        }
        return unique.filter((o) => missing.has(o));
      },
    },
  };
}
