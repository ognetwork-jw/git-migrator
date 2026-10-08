/**
 * The adapter contract suite (TST-015). It is parameterized by a connection factory, so the same
 * suite could run against a live provider later; v1 CI runs it against the fakes only (TST-006).
 *
 * Per Facet an adapter declares readable:
 * - with an `apply` on its driver: read -> apply -> read returns the desired document, the
 *   MutationRecords of the apply are well formed and cover what changed (ADP-012), and a second
 *   apply of the same document yields no record (ADP-011);
 * - without one (`write: false`): the read is valid per the Facet schema and stable across two
 *   reads, and a scenario may assert that seeded data appears in it.
 *
 * Equality is strict (`toEqual`). A scenario may declare one `normalisation` where a round-trip is
 * legitimately unequal; the kinds are an allow-list (N1 to N4, ADR-0250) and each adapter declares
 * how many scenarios use each.
 */
import type {
  DriverContext,
  EndpointConnection,
  FacetDriver,
  FacetRead,
  FacetTarget,
  MutationRecord,
  ProviderCapabilities,
} from '@git-migrator/adapter-sdk';
import { CANONICAL_FACETS, type FacetKey, parseCanonical } from '@git-migrator/canonical';
import { flattenDocument, isFieldPath } from '@git-migrator/core';
import { describe, expect, it } from 'vitest';

export const NORMALISATION_IDS = ['N1', 'N2', 'N3', 'N4'] as const;
export type NormalisationId = (typeof NORMALISATION_IDS)[number];

/** One connection to a provider (or its fake) with the context drivers run in. */
export interface ContractConnection<W> {
  /** Adapter-specific handle to the fake, for seeding and for `settle`. */
  world: W;
  conn: EndpointConnection;
  ctx: DriverContext;
}

/** A legitimate difference between the desired document and its read-back. */
export interface Normalisation {
  /** The allow-listed kind (ADR-0250). */
  id: NormalisationId;
  /** The ADR that records the difference, for example `ADR-0250`. */
  adr: string;
  reason: string;
  /** The document the read-back is expected to equal. */
  expected: unknown;
}

export interface Prepared {
  target: FacetTarget;
  /** Absent for a read-only scenario. */
  desired?: unknown;
  normalisation?: Normalisation;
  /** Runs between apply and the read-back, for example to merge a Change Request. */
  settle?: () => Promise<void> | void;
  /** Replaces the driver context for this scenario. */
  ctx?: DriverContext;
  /** Extra checks on the records of the first apply. */
  checkRecords?: (records: MutationRecord[]) => void;
  /** The first apply is expected to change nothing (waives the "at least one record" rule). */
  noop?: boolean;
  /** Substrings that must appear in no record (secret values, credential-bearing URLs). */
  forbidden?: string[];
  /** Read-only scenarios: checks on the read data, so a read that drops seeded data fails. */
  checkRead?: (data: unknown) => void;
}

export interface Scenario<W> {
  facet: FacetKey;
  name: string;
  /** Seeds the fake (a fresh connection per scenario) and describes what to apply. */
  prepare(connection: ContractConnection<W>): Promise<Prepared> | Prepared;
  /** A genuine adapter defect this scenario exposes: its writable checks run with `it.fails`. */
  knownDefect?: string;
}

export interface AdapterContract<W> {
  name: string;
  /** A fresh, independent world and connection each call. */
  connect(): Promise<ContractConnection<W>>;
  capabilities: ProviderCapabilities;
  scenarios: Scenario<W>[];
  /** How many scenarios use each normalisation. Any other use fails the suite. */
  normalisations: Partial<Record<NormalisationId, number>>;
}

export async function collect<T>(iterable: AsyncIterable<T> | undefined): Promise<T[]> {
  const out: T[] = [];
  if (iterable) for await (const item of iterable) out.push(item);
  return out;
}

function driverOf(connection: ContractConnection<unknown>, facet: FacetKey): FacetDriver<unknown> {
  const driver = connection.conn.facets[facet];
  if (!driver) throw new Error(`the adapter has no driver for ${facet}`);
  return driver;
}

/** The read is schema-valid canonical data (ADP-011). */
function expectValid(facet: FacetKey, read: FacetRead<unknown>): void {
  const parsed = parseCanonical(facet, read.data);
  expect(parsed.success, `${facet}: ${JSON.stringify(parsed)}`).toBe(true);
  expect(Array.isArray(read.unreadable)).toBe(true);
}

const SECRET_SHAPES = [
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{8,}/,
  /\bAT(?:ATT|CTT|BB)[A-Za-z0-9_=+/-]{12,}/,
  /BEGIN [A-Z ]*PRIVATE KEY/,
  /[?&](?:token|secret|password|key)=(?!\[REDACTED\])[^&\s"]+/i,
];

/** Whether a record path is, contains or lies inside a changed field path. */
function covers(recordPath: string, changed: string): boolean {
  if (recordPath === changed || recordPath === '/') return true;
  const inside = (outer: string, inner: string) =>
    inner.startsWith(`${outer}/`) || inner.startsWith(`${outer}[`);
  return inside(recordPath, changed) || inside(changed, recordPath);
}

/**
 * ADP-012: the records of one apply are well formed, carry no secret, are not duplicated, and
 * together cover every field that differs between the read before and the expected read-back.
 */
export function checkMutationRecords(
  facet: FacetKey,
  records: readonly MutationRecord[],
  context: { before: unknown; expected: unknown; forbidden?: string[] | undefined },
): void {
  const seen = new Set<string>();
  for (const record of records) {
    const label = `${facet} record ${JSON.stringify(record.paths)}`;
    expect(record.facetKey === facet || record.facetKey === null, `${label}: facetKey`).toBe(true);
    expect(['create', 'update', 'delete'], `${label}: action`).toContain(record.action);
    expect(record.paths.length, `${label}: has paths`).toBeGreaterThan(0);
    for (const path of record.paths) expect(isFieldPath(path), `${label}: ${path}`).toBe(true);
    expect(Object.keys(record.resourceRef).length, `${label}: resourceRef`).toBeGreaterThan(0);
    const text = JSON.stringify(record);
    for (const shape of SECRET_SHAPES) expect(text, `${label}: secret shape`).not.toMatch(shape);
    for (const word of context.forbidden ?? []) {
      expect(text, `${label}: leaks ${word}`).not.toContain(word);
    }
    const identity = JSON.stringify([record.action, record.resourceRef, [...record.paths].sort()]);
    expect(seen.has(identity), `${label}: duplicate record`).toBe(false);
    seen.add(identity);
  }
  const schema = CANONICAL_FACETS[facet].documentSchema;
  const before = flattenDocument(context.before, schema);
  const after = flattenDocument(context.expected, schema);
  const changed = new Set<string>();
  for (const [path, value] of after) {
    if (JSON.stringify(before.get(path)) !== JSON.stringify(value)) changed.add(path);
  }
  for (const path of before.keys()) if (!after.has(path)) changed.add(path);
  const recorded = records.flatMap((r) => [...r.paths]);
  for (const path of changed) {
    expect(
      recorded.some((p) => covers(p, path)),
      `${facet}: changed field ${path} is covered by a record path (${recorded.join(', ')})`,
    ).toBe(true);
  }
}

/** Read-only contract: valid per the schema, stable across two reads, seeded data present. */
export async function checkReadOnly(
  connection: ContractConnection<unknown>,
  facet: FacetKey,
  prepared: Prepared,
): Promise<void> {
  const driver = driverOf(connection, facet);
  expect(driver.apply, `${facet} is read-only`).toBeUndefined();
  const ctx = prepared.ctx ?? connection.ctx;
  const first = await driver.read(ctx, prepared.target);
  const second = await driver.read(ctx, prepared.target);
  expectValid(facet, first);
  expectValid(facet, second);
  expect(second.data).toEqual(first.data);
  expect(second.unreadable).toEqual(first.unreadable);
  prepared.checkRead?.(first.data);
}

/** Round-trip contract: read, apply, read; the result equals the desired document. */
export async function checkRoundTrip(
  connection: ContractConnection<unknown>,
  facet: FacetKey,
  prepared: Prepared,
): Promise<{ records: MutationRecord[] }> {
  const driver = driverOf(connection, facet);
  const apply = driver.apply;
  if (!apply) throw new Error(`${facet} has no apply`);
  const ctx = prepared.ctx ?? connection.ctx;
  if (prepared.normalisation) {
    expect(NORMALISATION_IDS).toContain(prepared.normalisation.id);
    expect(prepared.normalisation.adr).toMatch(/^ADR-025\d$/);
    expect(prepared.normalisation.reason.length).toBeGreaterThan(0);
  }
  const expected = prepared.normalisation?.expected ?? prepared.desired;
  const parsedDesired = parseCanonical(facet, prepared.desired);
  expect(parsedDesired.success, `${facet}: the desired document is valid`).toBe(true);
  const before = await driver.read(ctx, prepared.target);
  expectValid(facet, before);
  const records = await collect(
    apply.call(driver, ctx, prepared.target, prepared.desired, before.data, []),
  );
  if (!prepared.noop) {
    expect(records.length, `${facet}: the first apply yields a record`).toBeGreaterThan(0);
  }
  checkMutationRecords(facet, records, {
    before: before.data,
    expected,
    forbidden: prepared.forbidden,
  });
  prepared.checkRecords?.(records);
  await prepared.settle?.();
  const after = await driver.read(ctx, prepared.target);
  expectValid(facet, after);
  expect(after.data).toEqual(expected);
  return { records };
}

/** Idempotency contract: applying the same desired document again yields zero records. */
export async function checkIdempotent(
  connection: ContractConnection<unknown>,
  facet: FacetKey,
  prepared: Prepared,
): Promise<void> {
  const driver = driverOf(connection, facet);
  const apply = driver.apply;
  if (!apply) throw new Error(`${facet} has no apply`);
  const ctx = prepared.ctx ?? connection.ctx;
  const expected = prepared.normalisation?.expected ?? prepared.desired;
  const before = await driver.read(ctx, prepared.target);
  const first = await collect(
    apply.call(driver, ctx, prepared.target, prepared.desired, before.data, []),
  );
  if (!prepared.noop) {
    expect(first.length, `${facet}: the first apply changes something`).toBeGreaterThan(0);
  }
  checkMutationRecords(facet, first, {
    before: before.data,
    expected,
    forbidden: prepared.forbidden,
  });
  await prepared.settle?.();
  const settled = await driver.read(ctx, prepared.target);
  expect(settled.data).toEqual(expected);
  const again = await collect(
    apply.call(driver, ctx, prepared.target, prepared.desired, settled.data, []),
  );
  expect(again, `${facet}: the second apply yields no record`).toEqual([]);
  // A caller that passes no current state gets the same answer.
  const blind = await collect(apply.call(driver, ctx, prepared.target, prepared.desired, null, []));
  expect(blind, `${facet}: apply without current state yields no record`).toEqual([]);
  const final = await driver.read(ctx, prepared.target);
  expect(final.data).toEqual(settled.data);
}

export function defineAdapterContract<W>(contract: AdapterContract<W>): void {
  const readable = Object.entries(contract.capabilities.facets)
    .filter(([, cap]) => cap?.read)
    .map(([facet]) => facet as FacetKey);

  describe(`adapter contract: ${contract.name}`, () => {
    it('[TST-015] every readable Facet has a contract scenario and a driver', async () => {
      const connection = await contract.connect();
      const covered = new Set(contract.scenarios.map((s) => s.facet));
      for (const facet of readable) {
        expect(covered.has(facet), `${facet} has a scenario`).toBe(true);
        expect(connection.conn.facets[facet], `${facet} has a driver`).toBeDefined();
      }
      for (const facet of covered) expect(readable).toContain(facet);
    });

    it('[TST-015] a Facet is writable exactly when its driver has apply', async () => {
      const connection = await contract.connect();
      for (const facet of readable) {
        const writable = contract.capabilities.facets[facet]?.write === true;
        const driver = connection.conn.facets[facet];
        expect(typeof driver?.apply === 'function', `${facet}: apply iff write`).toBe(writable);
      }
    });

    it('[TST-015] normalisations are limited to the allow-list and counted per adapter', async () => {
      const used: Record<string, number> = {};
      for (const scenario of contract.scenarios) {
        const prepared = await scenario.prepare(await contract.connect());
        const id = prepared.normalisation?.id;
        if (id) used[id] = (used[id] ?? 0) + 1;
      }
      expect(used).toEqual(contract.normalisations);
    });

    for (const scenario of contract.scenarios) {
      const writable = contract.capabilities.facets[scenario.facet]?.write === true;
      const label = `${scenario.facet}: ${scenario.name}`;

      if (!writable) {
        it(`[TST-015] ${label} reads valid and stable (read-only)`, async () => {
          const connection = await contract.connect();
          const prepared = await scenario.prepare(connection);
          expect(prepared.desired).toBeUndefined();
          await checkReadOnly(connection, scenario.facet, prepared);
        });
        continue;
      }

      const run = scenario.knownDefect ? it.fails : it;
      run(`[TST-015] ${label} read -> apply -> read is equal`, async () => {
        const connection = await contract.connect();
        const prepared = await scenario.prepare(connection);
        await checkRoundTrip(connection, scenario.facet, prepared);
      });

      run(
        `[TST-015] ${label} applying the same document twice yields zero records the second time`,
        async () => {
          const connection = await contract.connect();
          const prepared = await scenario.prepare(connection);
          await checkIdempotent(connection, scenario.facet, prepared);
        },
      );
    }
  });
}
