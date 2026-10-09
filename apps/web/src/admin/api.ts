import { apiRequest } from '../api/http.ts';
import { findMany } from '../model/rpc.ts';

const enc = encodeURIComponent;

export type ActorKind = 'human' | 'service';
export type RoleName = 'viewer' | 'operator' | 'admin';

export interface ActorRow {
  readonly id: string;
  readonly kind: ActorKind;
  readonly displayName: string;
  readonly email: string | null;
  readonly role: RoleName;
  readonly disabled: boolean;
}

/** An API key as the list shows it. The hash is never selected (API-012); the prefix is public. */
export interface ApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/** The answer of `POST /actors/{id}/api-keys`. The full key is in `key`, once, and nowhere else. */
export interface IssuedKey {
  readonly id: string;
  readonly actorId: string;
  readonly name: string;
  readonly prefix: string;
  readonly expiresAt: string | null;
  readonly key: string;
}

export interface AuditRow {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly data: unknown;
  readonly at: string;
}

export const actorsKey = ['admin', 'actors'] as const;
export const apiKeysKey = (actorId: string) => ['admin', 'api-keys', actorId] as const;

export const fetchActors = () =>
  findMany<ActorRow>('actor', {
    select: { id: true, kind: true, displayName: true, email: true, role: true, disabled: true },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
  });

export const createServiceActor = (displayName: string, role: RoleName) =>
  apiRequest<ActorRow>('/api/v1/actors', {
    method: 'POST',
    json: { displayName, role },
  });

export const setActorDisabled = (id: string, disabled: boolean) =>
  apiRequest<ActorRow>(`/api/v1/actors/${enc(id)}`, {
    method: 'PATCH',
    json: { disabled },
  });

export const fetchApiKeys = (actorId: string) =>
  findMany<ApiKeyRow>('apiKey', {
    where: { actorId },
    select: {
      id: true,
      name: true,
      prefix: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

/**
 * Issues a key. The caller takes the answer into the one-time dialog's own state. It is not
 * returned by a mutation hook, which would keep it in the mutation cache (ADR-0365).
 */
export const issueApiKey = (actorId: string, name: string, expiresAt?: string) =>
  apiRequest<IssuedKey>(`/api/v1/actors/${enc(actorId)}/api-keys`, {
    method: 'POST',
    json: expiresAt === undefined ? { name } : { name, expiresAt },
  });

export const revokeApiKey = (id: string) =>
  apiRequest<void>(`/api/v1/api-keys/${enc(id)}`, { method: 'DELETE' });

export const AUDIT_PAGE = 50;

export interface AuditFilter {
  readonly actorId?: string;
  readonly action?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  /** Inclusive ISO bounds on `at`. */
  readonly from?: string;
  readonly to?: string;
}

/** Newest first, cursor paginated on the event id (UI-035). */
export const fetchAuditPage = (filter: AuditFilter, cursor?: string) => {
  const at =
    filter.from || filter.to
      ? {
          ...(filter.from ? { gte: filter.from } : {}),
          ...(filter.to ? { lte: filter.to } : {}),
        }
      : undefined;
  const where = {
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.action ? { action: { contains: filter.action } } : {}),
    ...(filter.subjectType ? { subjectType: filter.subjectType } : {}),
    ...(filter.subjectId ? { subjectId: filter.subjectId } : {}),
    ...(at ? { at } : {}),
  };
  return findMany<AuditRow>('auditEvent', {
    where,
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: AUDIT_PAGE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
};
