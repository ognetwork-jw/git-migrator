import { createTestDatabase, type TestDatabase } from '@git-migrator/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_KEY_PATTERN,
  ApiKeyError,
  generateApiKey,
  hashApiKey,
  issueApiKey,
  LAST_USED_INTERVAL_MS,
  revokeApiKey,
  verifyApiKey,
} from './api-keys.ts';
import { can } from './capabilities.ts';

let t: TestDatabase;
let adminId: string;
let serviceId: string;
let humanId: string;
const MISSING = '00000000-0000-7000-8000-000000000000';

beforeAll(async () => {
  t = await createTestDatabase('gm_t021k_');
  const db = t.db.privileged;
  adminId = (await db.actor.create({ data: { kind: 'human', displayName: 'a', role: 'admin' } }))
    .id;
  humanId = (await db.actor.create({ data: { kind: 'human', displayName: 'h', role: 'viewer' } }))
    .id;
  serviceId = (
    await db.actor.create({ data: { kind: 'service', displayName: 'svc', role: 'operator' } })
  ).id;
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

describe('[AUTH-040] key format and storage', () => {
  it('[AUTH-040] a key is gm_<8 base62>_<32 base62> and keys differ', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).toMatch(API_KEY_PATTERN);
    expect(a.key.length).toBe(3 + 8 + 1 + 32);
    expect(a.prefix).toBe(a.key.slice(3, 11));
    expect(a.hash).toBe(hashApiKey(a.key));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.key).not.toBe(a.key);
  });

  it('[AUTH-040] only sha256(key) is stored, and issuing is audited', async () => {
    const issued = await issueApiKey(t.db.privileged, {
      actorId: serviceId,
      name: 'ci',
      issuedBy: adminId,
    });
    const rows = await t.db.pool.query('SELECT * FROM app.api_key WHERE id = $1', [issued.id]);
    expect(rows.rows[0].hash).toBe(hashApiKey(issued.key));
    expect(JSON.stringify(rows.rows[0])).not.toContain(issued.key);
    expect(rows.rows[0].prefix).toBe(issued.prefix);
    const audit = await t.db.privileged.auditEvent.findFirst({ where: { subjectId: issued.id } });
    expect(audit).toMatchObject({ action: 'api_key.issue', actorId: adminId });
    expect(JSON.stringify(audit)).not.toContain(issued.key);
  });

  it('[AUTH-040] human Actors cannot have keys, and unknown Actors are refused', async () => {
    await expect(
      issueApiKey(t.db.privileged, { actorId: humanId, name: 'x', issuedBy: adminId }),
    ).rejects.toMatchObject({ code: 'actor_not_service' });
    await expect(
      issueApiKey(t.db.privileged, { actorId: MISSING, name: 'x', issuedBy: adminId }),
    ).rejects.toBeInstanceOf(ApiKeyError);
  });
});

describe('[AUTH-040] verification', () => {
  const issue = (expiresAt?: Date) =>
    issueApiKey(t.db.privileged, { actorId: serviceId, name: 'k', expiresAt, issuedBy: adminId });

  it('[AUTH-040] a valid key resolves to its service Actor', async () => {
    const { key } = await issue();
    const result = await verifyApiKey(t.db.privileged, key);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.actor.id).toBe(serviceId);
  });

  it('[AUTH-040] a wrong secret, a malformed key and an unknown prefix are all invalid', async () => {
    const { key } = await issue();
    const wrong = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`;
    for (const bad of [wrong, 'nope', `${key}x`, generateApiKey().key, '', 'Bearer x']) {
      expect(await verifyApiKey(t.db.privileged, bad)).toEqual({ status: 'invalid' });
    }
  });

  it('[AUTH-040] a revoked key and an expired key are invalid', async () => {
    const revoked = await issue();
    await revokeApiKey(t.db.privileged, revoked.id, adminId);
    await revokeApiKey(t.db.privileged, revoked.id, adminId);
    expect((await verifyApiKey(t.db.privileged, revoked.key)).status).toBe('invalid');
    expect(
      await t.db.privileged.auditEvent.count({
        where: { subjectId: revoked.id, action: 'api_key.revoke' },
      }),
    ).toBe(1);
    await expect(revokeApiKey(t.db.privileged, MISSING, adminId)).rejects.toMatchObject({
      code: 'key_not_found',
    });

    const expired = await issue(new Date(Date.now() + 1000));
    expect((await verifyApiKey(t.db.privileged, expired.key)).status).toBe('ok');
    expect(
      (await verifyApiKey(t.db.privileged, expired.key, new Date(Date.now() + 5000))).status,
    ).toBe('invalid');
  });

  it('[AUTH-040] a disabled service Actor invalidates its keys', async () => {
    const svc = await t.db.privileged.actor.create({
      data: { kind: 'service', displayName: 'off', role: 'viewer', disabled: true },
    });
    const { key } = await issueApiKey(t.db.privileged, {
      actorId: svc.id,
      name: 'k',
      issuedBy: adminId,
    });
    expect((await verifyApiKey(t.db.privileged, key)).status).toBe('invalid');
  });

  it('[AUTH-040] lastUsedAt is updated at most once a minute', async () => {
    const { key, id } = await issue();
    const lastUsed = async () =>
      (await t.db.privileged.apiKey.findUnique({ where: { id } }))?.lastUsedAt?.getTime();
    const t0 = new Date('2030-01-01T00:00:00Z');
    await verifyApiKey(t.db.privileged, key, t0);
    expect(await lastUsed()).toBe(t0.getTime());
    await verifyApiKey(t.db.privileged, key, new Date(t0.getTime() + 30_000));
    expect(await lastUsed()).toBe(t0.getTime());
    const later = new Date(t0.getTime() + LAST_USED_INTERVAL_MS + 1);
    await verifyApiKey(t.db.privileged, key, later);
    expect(await lastUsed()).toBe(later.getTime());
  });
});

describe('[AUTH-021] can(actor, capability)', () => {
  const as = (role: 'viewer' | 'operator' | 'admin', disabled = false) => ({ role, disabled });
  it('[AUTH-021] follows the AUTH-020 table', () => {
    expect(can(as('viewer'), 'read')).toBe(true);
    expect(can(as('viewer'), 'readAuditLog')).toBe(true);
    expect(can(as('viewer'), 'readRawResponses')).toBe(false);
    expect(can(as('operator'), 'operate')).toBe(true);
    expect(can(as('operator'), 'manageRules')).toBe(false);
    expect(can(as('operator'), 'manageActors')).toBe(false);
    expect(can(as('admin'), 'manageActors')).toBe(true);
    expect(can(as('admin'), 'manageRules')).toBe(true);
  });
  it('[AUTH-021] an absent or disabled Actor holds nothing', () => {
    expect(can(undefined, 'read')).toBe(false);
    expect(can(as('admin', true), 'read')).toBe(false);
  });
});
