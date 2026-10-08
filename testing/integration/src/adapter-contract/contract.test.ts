/** The contract checks themselves must pass an honest driver and fail a misbehaving one (TST-015). */
import type {
  DriverContext,
  EndpointConnection,
  FacetTarget,
  MutationRecord,
} from '@git-migrator/adapter-sdk';
import type { OrgVariables, RepositorySettings } from '@git-migrator/canonical';
import { describe, expect, it } from 'vitest';
import {
  type ContractConnection,
  checkIdempotent,
  checkReadOnly,
  checkRoundTrip,
  type Prepared,
} from './contract.ts';

const target: FacetTarget = { scope: 'endpoint', namespace: { providerId: '', slug: 'acme' } };

const record = (extra: Partial<MutationRecord> = {}): MutationRecord => ({
  facetKey: 'repository-settings',
  action: 'update',
  paths: ['/description'],
  resourceRef: { kind: 'repository', slug: 'r' },
  before: null,
  after: null,
  ...extra,
});

const settings = (description: string): RepositorySettings => ({
  description,
  homepage: null,
  visibility: 'private',
  features: { issues: true, wiki: true },
  forking: 'allowed',
});

interface Options {
  /** Stores something other than it was given. */
  lossy?: boolean;
  /** Reports a change on every apply. */
  chatty?: boolean;
  /** No apply. */
  readOnly?: boolean;
  /** Changes the stored value and reports nothing. */
  silent?: boolean;
  /** Reports the right change under the wrong path. */
  wrongPaths?: boolean;
  /** Reports every change twice. */
  duplicate?: boolean;
  /** Reports the change under another Facet. */
  wrongFacet?: boolean;
  /** Puts a credential-bearing URL in the record. */
  leaks?: boolean;
}

function connection(options: Options) {
  let stored = settings('old');
  const driver = {
    read: async () => ({ data: stored, unreadable: [], warnings: [], rawResponseIds: [] }),
    apply: options.readOnly
      ? undefined
      : async function* (_ctx: DriverContext, _target: FacetTarget, desired: RepositorySettings) {
          const differs = JSON.stringify(desired) !== JSON.stringify(stored);
          stored = options.lossy ? { ...desired, description: `${desired.description}!` } : desired;
          if (options.silent) return;
          if (!differs && !options.chatty) return;
          const r = record({
            ...(options.wrongPaths ? { paths: ['/homepage'] } : {}),
            ...(options.wrongFacet ? { facetKey: 'webhooks' } : {}),
            ...(options.leaks ? { resourceRef: { url: 'https://ci.test/hook?token=abc123' } } : {}),
          });
          yield r;
          if (options.duplicate) yield r;
        },
  };
  const conn = { facets: { 'repository-settings': driver } } as unknown as EndpointConnection;
  return { world: undefined, conn, ctx: {} as DriverContext } as ContractConnection<unknown>;
}

const prepared = (extra: Partial<Prepared> = {}): Prepared => ({
  target,
  desired: settings('new'),
  ...extra,
});

describe('contract checks', () => {
  it('[TST-015] an honest driver passes the round-trip and idempotency checks', async () => {
    const { records } = await checkRoundTrip(connection({}), 'repository-settings', prepared());
    expect(records).toHaveLength(1);
    await checkIdempotent(connection({}), 'repository-settings', prepared());
  });

  it('[TST-015] a round-trip that does not return the desired document is caught', async () => {
    await expect(
      checkRoundTrip(connection({ lossy: true }), 'repository-settings', prepared()),
    ).rejects.toThrow(/new!/);
  });

  it('[TST-015] a declared normalisation makes exactly that difference acceptable', async () => {
    await checkRoundTrip(
      connection({ lossy: true }),
      'repository-settings',
      prepared({
        normalisation: { id: 'N4', adr: 'ADR-0250', reason: 'a test', expected: settings('new!') },
      }),
    );
  });

  it('[TST-015] an apply that reports a change every time is caught by the idempotency check', async () => {
    await expect(
      checkIdempotent(connection({ chatty: true }), 'repository-settings', prepared()),
    ).rejects.toThrow(/second apply/);
  });

  it('[TST-015] a read-only check rejects a driver that has apply and passes one that has not', async () => {
    await expect(
      checkReadOnly(connection({}), 'repository-settings', { target }),
    ).rejects.toThrow();
    await checkReadOnly(connection({ readOnly: true }), 'repository-settings', { target });
  });

  it('[TST-015] a read-only check fails when the read drops seeded data', async () => {
    const dropped = prepared({
      checkRead: (data) => expect((data as RepositorySettings).description).toBe('seeded'),
    });
    delete (dropped as { desired?: unknown }).desired;
    await expect(
      checkReadOnly(connection({ readOnly: true }), 'repository-settings', dropped),
    ).rejects.toThrow(/seeded/);
  });

  it('[TST-015] a normalisation must be an allow-listed kind citing an ADR in the contract range', async () => {
    const normalisation = {
      id: 'N4' as const,
      adr: 'ADR-0250',
      reason: 'x',
      expected: settings('new'),
    };
    await expect(
      checkRoundTrip(
        connection({}),
        'repository-settings',
        prepared({ normalisation: { ...normalisation, adr: 'ADR-0001' } }),
      ),
    ).rejects.toThrow();
    await expect(
      checkRoundTrip(
        connection({}),
        'repository-settings',
        prepared({ normalisation: { ...normalisation, id: 'N9' as never } }),
      ),
    ).rejects.toThrow();
  });
});

describe('MutationRecord checks (ADP-012)', () => {
  it.each([
    ['record paths that do not cover the change', { wrongPaths: true }, /not covered|covered by/],
    ['duplicate records', { duplicate: true }, /duplicate record/],
    ['a change with no record at all', { silent: true }, /yields a record/],
    ['a record attributed to another Facet', { wrongFacet: true }, /facetKey/],
    ['a credential in a record', { leaks: true }, /secret shape/],
  ] as [string, Options, RegExp][])('[TST-015] %s is caught', async (_name, options, message) => {
    await expect(
      checkRoundTrip(connection(options), 'repository-settings', prepared()),
    ).rejects.toThrow(message);
    await expect(
      checkIdempotent(connection(options), 'repository-settings', prepared()),
    ).rejects.toThrow();
  });

  it('[TST-015] a scenario forbids substrings in records', async () => {
    await expect(
      checkRoundTrip(
        connection({}),
        'repository-settings',
        prepared({ forbidden: ['repository'] }),
      ),
    ).rejects.toThrow(/leaks repository/);
  });

  it('[TST-015] a record-free first apply passes only when the scenario declares a no-op', async () => {
    await checkRoundTrip(
      connection({ silent: true }),
      'repository-settings',
      prepared({ desired: settings('old'), noop: true }),
    );
  });
});

describe('target-only items (ADR-0231 section 1)', () => {
  const variable = (name: string) => ({
    name,
    value: name.toLowerCase(),
    visibility: 'all' as const,
  });

  /** An org-variables store whose apply either merges (honest) or replaces (deletes target-only). */
  function store(replaces: boolean) {
    let stored: OrgVariables = { variables: [variable('MINE')] };
    const driver = {
      read: async () => ({ data: stored, unreadable: [], warnings: [], rawResponseIds: [] }),
      apply: async function* (_c: DriverContext, _t: FacetTarget, desired: OrgVariables) {
        stored = replaces
          ? desired
          : {
              variables: [...stored.variables, ...desired.variables].sort((a, b) =>
                a.name < b.name ? -1 : 1,
              ),
            };
        yield record({
          facetKey: 'org-variables',
          paths: ['/variables[name=WANTED]'],
          resourceRef: { kind: 'org-variable', name: 'WANTED' },
        });
      },
    };
    const conn = { facets: { 'org-variables': driver } } as unknown as EndpointConnection;
    return { world: undefined, conn, ctx: {} as DriverContext } as ContractConnection<unknown>;
  }
  const keep: Prepared = {
    target,
    desired: { variables: [variable('WANTED')] },
    normalisation: {
      id: 'N3',
      adr: 'ADR-0250',
      reason: 'target-only items are kept',
      expected: { variables: [variable('MINE'), variable('WANTED')] },
    },
  };

  it('[TST-015] a driver that keeps target-only items passes', async () => {
    await checkRoundTrip(store(false), 'org-variables', keep);
  });

  it('[TST-015] a driver that deletes target-only items is caught', async () => {
    await expect(checkRoundTrip(store(true), 'org-variables', keep)).rejects.toThrow();
  });
});
