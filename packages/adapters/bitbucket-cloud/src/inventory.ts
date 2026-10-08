/** Inventory (JOB-030): namespaces, repositories, identities and groups. */
import {
  AdapterError,
  type GroupRecord,
  type IdentityRecord,
  type NamespaceRecord,
  type NamespaceRef,
  type Page,
  type RepositoryRecord,
  type RepositoryRef,
} from '@git-migrator/adapter-sdk';
import type { z } from 'zod';
import {
  account,
  enc,
  envelope,
  getOne,
  obj,
  parse,
  project,
  type Repository,
  repository,
} from './api.ts';
import { PROVIDER } from './config.ts';
import { discoverGroups } from './facets.ts';
import { principalId } from './mappers.ts';
import type { Ctx, Reader } from './reader.ts';

const REPO_FIELDS =
  'values.uuid,values.slug,values.name,values.full_name,values.is_private,values.size,values.updated_on,values.mainbranch.name,values.project.key,values.project.uuid,next';

/** Keys are `[A-Z0-9_]`; anything else would break the `q` filter, so it is refused. */
const PROJECT_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export function toRepositoryRecord(
  repo: Repository,
  ws: string,
  ns?: NamespaceRef,
): RepositoryRecord {
  const projectRef = repo.project;
  const namespace: NamespaceRef =
    ns ??
    (projectRef === undefined
      ? { providerId: ws, slug: ws }
      : { providerId: projectRef.uuid, slug: projectRef.key });
  const updated = repo.updated_on ? new Date(repo.updated_on) : undefined;
  return {
    providerId: repo.uuid,
    namespace,
    slug: repo.slug,
    name: repo.name,
    fullPath: `${ws}/${namespace.slug}/${repo.slug}`,
    isPrivate: repo.is_private,
    ...(typeof repo.size === 'number' ? { sizeBytes: repo.size } : {}),
    defaultBranch: repo.mainbranch?.name ?? null,
    ...(updated !== undefined && !Number.isNaN(updated.getTime())
      ? { providerUpdatedAt: updated }
      : {}),
  };
}

export function createInventory(reader: Reader, ctxOf: () => Ctx) {
  const page = async (
    path: string,
    cursor: string | undefined,
    query: Record<string, string | number>,
  ) => {
    const ctx = ctxOf();
    const res = await ctx.http.request({
      path: cursor ?? path,
      ...(cursor === undefined ? { query: { pagelen: 100, ...query } } : {}),
      pool: ctx.pool,
      signal: ctx.signal,
      capture: false,
    });
    return parse(envelope, res.body, path);
  };

  return {
    async listNamespaces(cursor?: string): Promise<Page<NamespaceRecord>> {
      const body = await page(`${reader.wsPath()}/projects`, cursor, {});
      const items: NamespaceRecord[] = [];
      if (cursor === undefined) {
        // The workspace is identified by its slug, the key the endpoint is configured with (ADR-0224).
        items.push({
          providerId: reader.workspace,
          kind: 'workspace',
          slug: reader.workspace,
          name: reader.workspace,
        });
      }
      for (const raw of body.values) {
        const p = parse(project, raw, 'project');
        items.push({
          providerId: p.uuid,
          parentProviderId: reader.workspace,
          kind: 'project',
          slug: p.key,
          key: p.key,
          name: p.name ?? p.key,
        });
      }
      return { items, ...(body.next !== undefined ? { nextCursor: body.next } : {}) };
    },

    async listRepositories(ns: NamespaceRef, cursor?: string): Promise<Page<RepositoryRecord>> {
      if (ns.providerId === reader.workspace) {
        throw new AdapterError({
          code: 'invalid',
          provider: PROVIDER,
          message: 'Repositories live in projects, not in the workspace',
        });
      }
      if (!PROJECT_KEY.test(ns.slug)) {
        throw new AdapterError({
          code: 'invalid',
          provider: PROVIDER,
          message: 'Invalid project key',
        });
      }
      const body = await page(`/2.0/repositories/${enc(reader.workspace)}`, cursor, {
        q: `project.key="${ns.slug}"`,
        sort: 'full_name',
        fields: REPO_FIELDS,
      });
      return {
        items: body.values.map((v) =>
          toRepositoryRecord(parse(repository, v, 'repository'), reader.workspace, ns),
        ),
        ...(body.next !== undefined ? { nextCursor: body.next } : {}),
      };
    },

    async getRepository(ref: RepositoryRef): Promise<RepositoryRecord | null> {
      const { data } = await getOne(
        { http: ctxOf().http, ctx: ctxOf() },
        reader.repoPath(ref.slug),
        repository,
        'repository',
        { optional: true, capture: false },
      );
      return data === undefined ? null : toRepositoryRecord(data, reader.workspace);
    },

    async findRepository(ns: NamespaceRef, name: string): Promise<RepositoryRecord | null> {
      if (!PROJECT_KEY.test(ns.slug)) return null;
      const quoted = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const body = await page(`/2.0/repositories/${enc(reader.workspace)}`, undefined, {
        q: `project.key="${ns.slug}" AND name="${quoted}"`,
        fields: REPO_FIELDS,
      });
      const first = body.values[0];
      return first === undefined
        ? null
        : toRepositoryRecord(parse(repository, first, 'repository'), reader.workspace, ns);
    },

    async listIdentities(cursor?: string): Promise<Page<IdentityRecord>> {
      const body = await page(`${reader.wsPath()}/members`, cursor, {});
      const items: IdentityRecord[] = [];
      for (const raw of body.values) {
        const row = parse(obj({ user: account }), raw, 'member');
        const id = principalId(row.user);
        if (id === undefined) continue;
        items.push({
          providerId: id,
          ...(row.user.nickname !== undefined ? { login: row.user.nickname } : {}),
          ...(row.user.display_name !== undefined ? { displayName: row.user.display_name } : {}),
          kind: row.user.type === 'app_user' ? 'bot' : 'user',
          isMember: true,
        });
      }
      return { items, ...(body.next !== undefined ? { nextCursor: body.next } : {}) };
    },

    async listGroups(): Promise<Page<GroupRecord>> {
      const ctx = ctxOf();
      const legacy = await reader.legacyGroups(ctx);
      if (legacy.groups !== null) {
        return {
          items: legacy.groups.map((g) => ({
            providerId: g.slug,
            slug: g.slug,
            name: g.name ?? g.slug,
            memberProviderIds: (g.members ?? []).flatMap((m) => {
              const id = principalId(m);
              return id === undefined ? [] : [id];
            }),
          })),
        };
      }
      const found = await discoverGroups(reader, ctx);
      return {
        items: found.groups.map((g) => ({
          providerId: g.slug,
          slug: g.slug,
          name: g.name,
          memberProviderIds: [],
        })),
      };
    },
  };
}

export type { z };
