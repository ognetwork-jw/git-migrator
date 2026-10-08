import { describe, expect, it } from 'vitest';
import { parseMappingCsv } from './csv.ts';
import {
  type ExistingMappingInfo,
  resolveRows,
  type SourceIdentityInfo,
  type TargetIdentityInfo,
} from './resolve.ts';

const sources: SourceIdentityInfo[] = [
  { id: 's1', providerId: '{acc-1}', login: 'alice', email: null, emailSource: null },
  {
    id: 's2',
    providerId: '{acc-2}',
    login: 'bob',
    email: 'bob@old.test',
    emailSource: 'atlassian-admin',
  },
  { id: 's3', providerId: '{acc-3}', login: 'Carol', email: null, emailSource: null },
  { id: 's4', providerId: '{acc-4}', login: 'carol', email: null, emailSource: null },
  { id: 's5', providerId: '{acc-5}', login: '-dash', email: null, emailSource: null },
];
const targets: TargetIdentityInfo[] = [
  { id: 't1', login: 'alice-gh', email: 'alice@example.test' },
  { id: 't2', login: 'bob-gh', email: null },
  { id: 't3', login: 'twin', email: 'twin@example.test' },
  { id: 't4', login: 'Twin', email: null },
];

const run = (csv: string, mappings: ExistingMappingInfo[] = []) =>
  resolveRows(parseMappingCsv(`source,target,action\n${csv}`).rows, sources, targets, mappings);

describe('[AUTH-050] CSV rows resolve against Identities', () => {
  it('[AUTH-050] resolves a source by account id or by login, and a target by login or email', () => {
    const rows = run(
      '{acc-1},alice-gh,map\nBOB,bob-gh,map\ncarol-nobody,x,map\n{acc-3},TWIN@example.test,map\n',
    );
    expect(rows[0]).toMatchObject({ ok: true, outcome: 'mapped' });
    expect(rows[0]?.plan).toMatchObject({ sourceIdentityId: 's1', targetIdentityId: 't1' });
    expect(rows[1]).toMatchObject({ ok: true });
    expect(rows[1]?.plan).toMatchObject({ sourceIdentityId: 's2', targetIdentityId: 't2' });
    expect(rows[2]?.errors).toContain('source_not_found');
    expect(rows[3]?.plan).toMatchObject({ sourceIdentityId: 's3', targetIdentityId: 't3' });
  });

  it('[AUTH-050] an ambiguous or unknown cell is an error, never a guess', () => {
    const rows = run(
      'carol,alice-gh,map\n{acc-1},nobody,map\n{acc-2},twin,map\n{acc-5},ghost@example.test,map\n',
    );
    expect(rows[0]?.errors).toEqual(['source_ambiguous']);
    expect(rows[1]?.errors).toEqual(['target_not_found']);
    expect(rows[2]?.errors).toEqual(['target_ambiguous']);
    expect(rows[3]?.errors).toEqual(['target_not_found']);
    expect(rows.every((r) => !r.ok && r.plan === null && r.outcome === null)).toBe(true);
  });

  it('[AUTH-050] the same source twice, or one target for two sources, is an error on the later row', () => {
    const dup = run('alice,alice-gh,map\n{acc-1},bob-gh,map\n');
    expect(dup.map((r) => r.errors)).toEqual([[], ['duplicate_source']]);
    const taken = run('alice,alice-gh,map\nbob,alice-gh,map\n');
    expect(taken.map((r) => r.errors)).toEqual([[], ['target_taken']]);
  });

  it('[AUTH-050] a target confirmed for another source is taken, unless the file moves that source', () => {
    const existing: ExistingMappingInfo[] = [
      { sourceIdentityId: 's2', status: 'confirmed', targetIdentityId: 't1' },
    ];
    expect(run('alice,alice-gh,map\n', existing)[0]?.errors).toEqual(['target_taken']);
    // bob moves to another target in the same file, so alice-gh is free.
    const moved = run('bob,bob-gh,map\nalice,alice-gh,map\n', existing);
    expect(moved.map((r) => r.errors)).toEqual([[], []]);
    const excludedFirst = run('bob,,exclude\nalice,alice-gh,map\n', existing);
    expect(excludedFirst.map((r) => r.ok)).toEqual([true, true]);
  });

  it('[AUTH-050] an unchanged row is reported as unchanged and has nothing to apply', () => {
    const rows = run('alice,alice-gh,map\nbob,,exclude\n', [
      { sourceIdentityId: 's1', status: 'confirmed', targetIdentityId: 't1' },
      { sourceIdentityId: 's2', status: 'excluded', targetIdentityId: null },
    ]);
    expect(rows.map((r) => r.outcome)).toEqual(['unchanged', 'unchanged']);
  });

  it('[AUTH-050] invite records the email; a provider email that differs is a conflict', () => {
    const rows = run(
      'alice,new@example.test,invite\nbob,bob@old.test,invite\nbob,other@example.test,invite\n',
    );
    expect(rows[0]).toMatchObject({ ok: true, outcome: 'invited' });
    expect(rows[0]?.plan?.setEmail).toBe('new@example.test');
    expect(rows[1]).toMatchObject({ ok: true });
    expect(rows[1]?.plan?.setEmail).toBeNull();
    expect(rows[2]?.errors).toContain('email_conflict');
  });

  it('[AUTH-050] echoed cells that start like a formula are neutralized, and a formula target is rejected', () => {
    const rows = run('-dash,@evil,map\n{acc-1},ok,exclude\n');
    expect(rows[0]?.source).toBe("'-dash");
    expect(rows[0]?.target).toBe("'@evil");
    expect(rows[0]?.errors).toContain('formula_prefix');
    expect(rows[1]?.errors).toEqual(['target_not_allowed']);
    expect(rows[1]?.source).toBe('{acc-1}');
  });

  it('[AUTH-050] an account id that is also another identity login is ambiguous', () => {
    const rows = resolveRows(
      parseMappingCsv('source,target,action\n{acc-1},alice-gh,map\n').rows,
      [
        ...sources,
        { id: 's9', providerId: '{acc-9}', login: '{acc-1}', email: null, emailSource: null },
      ],
      targets,
      [],
    );
    expect(rows[0]?.errors).toEqual(['source_ambiguous']);
  });

  it('[AUTH-050] invite on a confirmed or excluded mapping is already_decided', () => {
    const existing: ExistingMappingInfo[] = [
      { sourceIdentityId: 's1', status: 'confirmed', targetIdentityId: 't1' },
      { sourceIdentityId: 's3', status: 'excluded', targetIdentityId: null },
      { sourceIdentityId: 's4', status: 'suggested', targetIdentityId: 't2' },
    ];
    const rows = run(
      'alice,a@example.test,invite\n{acc-3},c@example.test,invite\n{acc-4},d@example.test,invite\n',
      existing,
    );
    expect(rows.map((r) => r.errors)).toEqual([['already_decided'], ['already_decided'], []]);
  });

  it('[AUTH-050] an unknown action is echoed as invalid', () => {
    expect(run('alice,x,=1+1\n')[0]?.action).toBe('invalid');
  });
});
