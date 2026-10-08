import { describe, expect, it } from 'vitest';
import {
  demoteDuplicateConfirmations,
  EMAIL_CONFIDENCE,
  indexTargets,
  LOGIN_CONFIDENCE,
  type MatchIdentity,
  type MatchOutcome,
  matchGroup,
  matchIdentity,
  NAME_CONFIDENCE,
  normalizeDisplayName,
  outcomeFields,
  REMATCHABLE_STATUSES,
  sameMapping,
} from './matching.ts';

const who = (id: string, fields: Partial<MatchIdentity> = {}): MatchIdentity => ({
  id,
  login: null,
  displayName: null,
  email: null,
  ...fields,
});

describe('identity matching cascade', () => {
  it('[AUTH-050] matches an email case-insensitively and confirms it when autoConfirmEmail is on', () => {
    const source = who('s', { email: 'Alice@Acme.Example', login: 'zzz' });
    const targets = [who('t1', { login: 'other' }), who('t2', { email: 'alice@acme.example' })];
    expect(matchIdentity(source, targets, { autoConfirmEmail: true })).toEqual({
      status: 'confirmed',
      method: 'email',
      confidence: EMAIL_CONFIDENCE,
      targetIdentityId: 't2',
    });
  });

  it('[AUTH-050] only suggests an email match when autoConfirmEmail is off', () => {
    const outcome = matchIdentity(
      who('s', { email: 'a@x.test' }),
      [who('t', { email: 'A@X.TEST' })],
      { autoConfirmEmail: false },
    );
    expect(outcome).toMatchObject({ status: 'suggested', method: 'email', targetIdentityId: 't' });
  });

  it('[AUTH-050] suggests a case-insensitive login match with confidence 0.9', () => {
    const outcome = matchIdentity(who('s', { login: 'Bob' }), [who('t', { login: 'bob' })], {
      autoConfirmEmail: true,
    });
    expect(outcome).toEqual({
      status: 'suggested',
      method: 'login',
      confidence: LOGIN_CONFIDENCE,
      targetIdentityId: 't',
    });
    expect(LOGIN_CONFIDENCE).toBe(0.9);
  });

  it('[AUTH-050] prefers the email over the login when both would match different people', () => {
    const outcome = matchIdentity(
      who('s', { email: 'a@x.test', login: 'bob' }),
      [who('by-login', { login: 'bob' }), who('by-email', { email: 'a@x.test' })],
      { autoConfirmEmail: true },
    );
    expect(outcome).toMatchObject({ method: 'email', targetIdentityId: 'by-email' });
  });

  it('[AUTH-050] suggests a normalized display-name match with exactly one candidate at 0.7', () => {
    const outcome = matchIdentity(
      who('s', { displayName: 'José  Müller-Ünal' }),
      [who('t1', { displayName: 'Someone Else' }), who('t2', { displayName: 'jose muller unal!' })],
      { autoConfirmEmail: true },
    );
    expect(outcome).toEqual({
      status: 'suggested',
      method: 'name',
      confidence: NAME_CONFIDENCE,
      targetIdentityId: 't2',
    });
    expect(NAME_CONFIDENCE).toBe(0.7);
  });

  it('[AUTH-050] leaves an ambiguous display name unmapped', () => {
    const outcome = matchIdentity(
      who('s', { displayName: 'Sam Lee' }),
      [who('t1', { displayName: 'sam lee' }), who('t2', { displayName: 'Sam-Lee' })],
      { autoConfirmEmail: true },
    );
    expect(outcome).toEqual({ status: 'unmapped' });
  });

  it('[AUTH-050] falls through an ambiguous email to the login step', () => {
    const outcome = matchIdentity(
      who('s', { email: 'shared@x.test', login: 'sam' }),
      [
        who('t1', { email: 'shared@x.test' }),
        who('t2', { email: 'shared@x.test' }),
        who('t3', { login: 'sam' }),
      ],
      { autoConfirmEmail: true },
    );
    expect(outcome).toMatchObject({ method: 'login', targetIdentityId: 't3' });
  });

  it('[AUTH-050] is unmapped when nothing matches, and ignores empty values', () => {
    expect(
      matchIdentity(
        who('s', { email: ' ', login: '', displayName: '!!!' }),
        [who('t', { email: ' ', login: '', displayName: '???' })],
        { autoConfirmEmail: true },
      ),
    ).toEqual({ status: 'unmapped' });
    expect(matchIdentity(who('s'), [], { autoConfirmEmail: true })).toEqual({ status: 'unmapped' });
  });

  it('[AUTH-050] normalizes with NFKD, lowercase and alphanumerics only', () => {
    expect(normalizeDisplayName('Ｆｕｌｌ Ｗｉｄｔｈ-1')).toBe('fullwidth1');
    expect(normalizeDisplayName('Zoë')).toBe('zoe');
    expect(normalizeDisplayName('  - ')).toBeNull();
    expect(normalizeDisplayName(null)).toBeNull();
  });

  it('[AUTH-050] rewrites only unmapped and suggested mappings', () => {
    expect([...REMATCHABLE_STATUSES].sort()).toEqual(['suggested', 'unmapped']);
    for (const decided of ['confirmed', 'excluded', 'pending_invite']) {
      expect(REMATCHABLE_STATUSES.has(decided)).toBe(false);
    }
  });

  it('[AUTH-050] compares stored mappings with an outcome field by field', () => {
    const unmapped = outcomeFields({ status: 'unmapped' });
    expect(unmapped).toEqual({
      status: 'unmapped',
      targetIdentityId: null,
      method: null,
      confidence: null,
    });
    const suggested = outcomeFields({
      status: 'suggested',
      method: 'login',
      confidence: 0.9,
      targetIdentityId: 't',
    });
    expect(sameMapping(suggested, { ...suggested })).toBe(true);
    expect(sameMapping(suggested, unmapped)).toBe(false);
    expect(sameMapping(suggested, { ...suggested, targetIdentityId: 'u' })).toBe(false);
  });
});

describe('group matching', () => {
  it('[AUTH-050] suggests an existing target team with the same slug, case-insensitively', () => {
    expect(matchGroup('Platform-Team', [{ id: 'g', slug: 'platform-team' }])).toEqual({
      status: 'suggested',
      targetGroupId: 'g',
    });
  });

  it('[AUTH-050] plans the team for creation when no target team has the slug', () => {
    expect(matchGroup('platform-team', [{ id: 'g', slug: 'other' }])).toEqual({
      status: 'unmapped',
      targetGroupId: null,
    });
  });
});

describe('indexed matching', () => {
  const build = (n: number) => ({
    sources: Array.from({ length: n }, (_, i) =>
      who(`s${i}`, { login: `user${i}`, displayName: `Person Number ${i}`, email: `p${i}@x.test` }),
    ),
    targets: Array.from({ length: n }, (_, i) =>
      who(`t${i}`, { login: `other${i}`, displayName: `Person Number ${i}` }),
    ),
  });

  it('[AUTH-050] normalizes each Identity once, so the work grows with sources plus targets', () => {
    const { sources, targets } = build(2000);
    let calls = 0;
    const counting = (value: string | null) => {
      calls++;
      return normalizeDisplayName(value);
    };
    const index = indexTargets(targets, counting);
    const outcomes = sources.map((s) => matchIdentity(s, index, { autoConfirmEmail: true }));
    expect(calls).toBe(targets.length + sources.length);
    // Every source found its one namesake by the display name.
    expect(
      outcomes.every((o, i) => o.status === 'suggested' && o.targetIdentityId === `t${i}`),
    ).toBe(true);
  });

  it('[AUTH-050] gives the same answer for an index as for the plain list', () => {
    const { sources, targets } = build(20);
    const index = indexTargets(targets);
    for (const source of sources) {
      expect(matchIdentity(source, index, { autoConfirmEmail: false })).toEqual(
        matchIdentity(source, targets, { autoConfirmEmail: false }),
      );
    }
  });

  it('[AUTH-050] demotes automatic confirmations that share a target or hit a taken one', () => {
    const confirmed = (id: string): MatchOutcome => ({
      status: 'confirmed',
      method: 'email',
      confidence: 1,
      targetIdentityId: id,
    });
    const out = demoteDuplicateConfirmations(
      [confirmed('a'), confirmed('a'), confirmed('b'), confirmed('c'), { status: 'unmapped' }],
      new Set(['c']),
    );
    expect(out.map((o) => o.status)).toEqual([
      'suggested',
      'suggested',
      'confirmed',
      'suggested',
      'unmapped',
    ]);
  });
});
