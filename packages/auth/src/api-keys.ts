import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Actor, Db } from '@git-migrator/db';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const PREFIX_LENGTH = 8;
const SECRET_LENGTH = 32;
/** `gm_<8-char prefix>_<32-char secret>`, base62 (AUTH-040). */
export const API_KEY_PATTERN = /^gm_([0-9A-Za-z]{8})_([0-9A-Za-z]{32})$/;
/** `lastUsedAt` is written at most this often (AUTH-040). */
export const LAST_USED_INTERVAL_MS = 60_000;
export const AUDIT_API_KEY_ISSUED = 'api_key.issue';
export const AUDIT_API_KEY_REVOKED = 'api_key.revoke';

function randomBase62(length: number): string {
  let out = '';
  // randomInt draws from the CSPRNG without modulo bias.
  for (let i = 0; i < length; i++) out += BASE62[randomInt(BASE62.length)];
  return out;
}

/** `sha256(key)` as hex: the only form of a key that is stored. */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export interface GeneratedApiKey {
  readonly key: string;
  readonly prefix: string;
  readonly hash: string;
}

/** A new key from the CSPRNG (AUTH-040). */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBase62(PREFIX_LENGTH);
  const key = `gm_${prefix}_${randomBase62(SECRET_LENGTH)}`;
  return { key, prefix, hash: hashApiKey(key) };
}

export type ApiKeyErrorCode = 'actor_not_found' | 'actor_not_service' | 'key_not_found';

export class ApiKeyError extends Error {
  readonly code: ApiKeyErrorCode;
  constructor(code: ApiKeyErrorCode, message: string) {
    super(message);
    this.name = 'ApiKeyError';
    this.code = code;
  }
}

export interface IssueApiKeyInput {
  /** The service Actor the key authenticates as. Human Actors cannot have keys. */
  readonly actorId: string;
  readonly name: string;
  readonly expiresAt?: Date | undefined;
  /** The admin issuing the key, recorded in the AuditEvent (AUTH-022). */
  readonly issuedBy: string;
}

export interface IssuedApiKey {
  readonly id: string;
  readonly actorId: string;
  readonly name: string;
  readonly prefix: string;
  readonly expiresAt: Date | null;
  /** The full key. Returned exactly once; only its hash is stored. */
  readonly key: string;
}

/** Issues a key for a service Actor and writes the AuditEvent in the same transaction. Privileged client. */
export async function issueApiKey(db: Db, input: IssueApiKeyInput): Promise<IssuedApiKey> {
  return db.$transaction(async (tx) => {
    const actor = await tx.actor.findUnique({ where: { id: input.actorId } });
    if (!actor) throw new ApiKeyError('actor_not_found', 'no such Actor');
    if (actor.kind !== 'service') {
      throw new ApiKeyError('actor_not_service', 'only service Actors can have API keys');
    }
    const generated = generateApiKey();
    const row = await tx.apiKey.create({
      data: {
        actorId: actor.id,
        name: input.name,
        prefix: generated.prefix,
        hash: generated.hash,
        expiresAt: input.expiresAt ?? null,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: input.issuedBy,
        action: AUDIT_API_KEY_ISSUED,
        subjectType: 'api_key',
        subjectId: row.id,
        data: { actorId: actor.id, name: input.name, prefix: generated.prefix },
      },
    });
    return {
      id: row.id,
      actorId: actor.id,
      name: row.name,
      prefix: row.prefix,
      expiresAt: row.expiresAt,
      key: generated.key,
    };
  });
}

/** Revokes a key (sets `revokedAt`) and audits it. Revoking twice keeps the first time. */
export async function revokeApiKey(db: Db, id: string, revokedBy: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const row = await tx.apiKey.findUnique({ where: { id } });
    if (!row) throw new ApiKeyError('key_not_found', 'no such API key');
    if (row.revokedAt) return;
    await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await tx.auditEvent.create({
      data: {
        actorId: revokedBy,
        action: AUDIT_API_KEY_REVOKED,
        subjectType: 'api_key',
        subjectId: id,
        data: { actorId: row.actorId, prefix: row.prefix },
      },
    });
  });
}

export type ApiKeyVerification =
  | { readonly status: 'ok'; readonly actor: Actor; readonly apiKeyId: string }
  | { readonly status: 'invalid' };

const INVALID: ApiKeyVerification = { status: 'invalid' };

/**
 * AUTH-040: finds the key by `prefix`, compares `sha256(key)` in constant time, and rejects a
 * revoked or expired key, a disabled Actor and a human Actor. Every failure is the same `invalid`
 * (the caller answers 401 without saying why). `lastUsedAt` is updated at most once a minute.
 * Uses the privileged client: the hash is not readable through RPC.
 */
export async function verifyApiKey(
  db: Db,
  key: string,
  now: Date = new Date(),
): Promise<ApiKeyVerification> {
  const match = API_KEY_PATTERN.exec(key);
  if (!match) return INVALID;
  const row = await db.apiKey.findUnique({
    where: { prefix: match[1] as string },
    include: { actor: true },
  });
  // Hash even when no row exists, so timing does not reveal which prefixes exist.
  const given = Buffer.from(hashApiKey(key), 'hex');
  const stored = Buffer.from(row?.hash ?? '0'.repeat(64), 'hex');
  const equal = given.length === stored.length && timingSafeEqual(given, stored);
  if (!row || !equal) return INVALID;
  if (row.revokedAt) return INVALID;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return INVALID;
  if (row.actor.disabled || row.actor.kind !== 'service') return INVALID;
  const cutoff = new Date(now.getTime() - LAST_USED_INTERVAL_MS);
  await db.apiKey.updateMany({
    where: { id: row.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
    data: { lastUsedAt: now },
  });
  return { status: 'ok', actor: row.actor, apiKeyId: row.id };
}
