import { apiRequest } from '../api/http.ts';
import type { IdentityRef } from '../mapping/api.ts';

export type BatchStatus = 'draft' | 'approved' | 'sending' | 'sent' | 'partial';
export type ItemStatus =
  | 'selected'
  | 'deselected'
  | 'sent'
  | 'accepted'
  | 'failed'
  | 'expired'
  | 'unknown';

export const BATCH_STATUSES: readonly BatchStatus[] = [
  'draft',
  'approved',
  'sending',
  'sent',
  'partial',
];
export const ITEM_STATUSES: readonly ItemStatus[] = [
  'selected',
  'deselected',
  'sent',
  'accepted',
  'failed',
  'expired',
  'unknown',
];

export interface Batch {
  readonly id: string;
  readonly routeId: string;
  readonly status: BatchStatus;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly nextAttemptAt: string | null;
  /** Identifies the reviewed selection; approval is refused when it changed. */
  readonly selectionToken: string;
  readonly seatPreview: {
    readonly toInvite: number;
    readonly seatsTotal: number | null;
    readonly seatsFilled: number | null;
    readonly projectedFilled: number | null;
  };
  readonly counts: Readonly<Record<ItemStatus, number>>;
}

export interface Item {
  readonly id: string;
  readonly status: ItemStatus;
  readonly email: string;
  readonly teamSlugs: readonly string[];
  readonly source: IdentityRef;
  readonly error: string | null;
  readonly deselectReason: string | null;
  readonly sentAt: string | null;
  /** False for an entry resolved as invited: a revoke may not find its invitation. */
  readonly providerIdKnown: boolean;
  readonly mappingId: string | null;
  readonly suggestions: readonly IdentityRef[];
}

export interface Candidate {
  readonly identity: IdentityRef;
  readonly teamSlugs: readonly string[];
}

const enc = encodeURIComponent;

/** Every query of these pages starts with this key, so one invalidation refreshes them all. */
export const invitationsKey = ['invitations'] as const;
export const batchesKey = (routeId: string, status: string) =>
  ['invitations', 'batches', routeId, status] as const;
export const batchKey = (id: string, status: string) =>
  ['invitations', 'batch', id, status] as const;
export const candidatesKey = (routeId: string, q: string) =>
  ['invitations', 'candidates', routeId, q] as const;

export const fetchBatches = (options: { routeId?: string; status?: string; cursor?: string }) => {
  const query = new URLSearchParams({ limit: '50' });
  if (options.routeId) query.set('routeId', options.routeId);
  if (options.status) query.set('status', options.status);
  if (options.cursor) query.set('cursor', options.cursor);
  return apiRequest<{ items: Batch[]; nextCursor: string | null }>(
    `/api/v1/invitation-batches?${query}`,
  );
};

export const fetchBatch = (id: string, options: { status?: string; cursor?: string }) => {
  const query = new URLSearchParams({ limit: '100' });
  if (options.status) query.set('status', options.status);
  if (options.cursor) query.set('cursor', options.cursor);
  return apiRequest<{ batch: Batch; items: Item[]; nextCursor: string | null }>(
    `/api/v1/invitation-batches/${enc(id)}?${query}`,
  );
};

export const fetchCandidates = (routeId: string, options: { q?: string; cursor?: string }) => {
  const query = new URLSearchParams({ limit: '100' });
  if (options.q) query.set('q', options.q);
  if (options.cursor) query.set('cursor', options.cursor);
  return apiRequest<{ items: Candidate[]; nextCursor: string | null }>(
    `/api/v1/routes/${enc(routeId)}/invitation-candidates?${query}`,
  );
};

export const createBatch = (routeId: string, body: { identityIds?: string[]; all?: boolean }) =>
  apiRequest<Batch>(`/api/v1/routes/${enc(routeId)}/invitation-batches`, {
    method: 'POST',
    json: body,
  });

export const decideItem = (
  batchId: string,
  itemId: string,
  action: 'select' | 'deselect' | 'revoke' | 'resolve',
  body: { reason?: string; outcome?: 'invited' | 'not_invited' } = {},
) =>
  apiRequest<{ status?: ItemStatus; queued?: true }>(
    `/api/v1/invitation-batches/${enc(batchId)}/items/${enc(itemId)}/${action}`,
    { method: 'POST', json: body },
  );

export const approveBatch = (batchId: string, expectedCount: number, expectedToken: string) =>
  apiRequest<{ approved: number; dropped: number; batch: Batch }>(
    `/api/v1/invitation-batches/${enc(batchId)}/approve`,
    { method: 'POST', json: { expectedCount, expectedToken } },
  );

/** Confirms a suggested member as the invitee of a `pending_invite` mapping (AUTH-060 step 5.2). */
export const confirmInvitee = (routeId: string, mappingId: string, targetIdentityId: string) =>
  apiRequest<unknown>(
    `/api/v1/routes/${enc(routeId)}/identity-mappings/${enc(mappingId)}/confirm`,
    { method: 'POST', json: { targetIdentityId } },
  );
