import { describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from './builtin.ts';
import type { CapabilityMatrix, MatrixCell } from './matrix.ts';

const SRC = 'bitbucket-cloud';
const DST = 'github';

/** Compact, stable projection of the matrix for the snapshot file. */
function project(matrix: CapabilityMatrix) {
  return matrix.rows.map((row) => ({
    facet: row.facet,
    scope: row.scope,
    inScope: row.inScope,
    cells: row.cells.map((c) => ({
      pair: `${c.source} -> ${c.target}`,
      fidelity: c.fidelity,
      read: c.read,
      write: c.write,
      override: c.override,
      fields: c.fields.map((f) => `${f.path}: ${f.fidelity}`),
    })),
  }));
}

const registry = createBuiltinRegistry();
const matrix = registry.capabilityMatrix();

function cell(facet: string, source = SRC, target = DST): MatrixCell {
  const found = matrix.rows
    .find((r) => r.facet === facet)
    ?.cells.find((c) => c.source === source && c.target === target);
  if (found === undefined) throw new Error(`no cell ${facet} ${source} -> ${target}`);
  return found;
}
const field = (facet: string, path: string) => cell(facet).fields.find((f) => f.path === path);

describe('built-in registry', () => {
  it('[ADP-032] composes all 19 facets, both adapters and the pipelines pair override', () => {
    expect(registry.facets.keys()).toHaveLength(19);
    expect(registry.adapterTypes()).toEqual([SRC, DST]);
    expect(registry.override(SRC, DST, 'pipelines')).toBeDefined();
    expect(registry.facets.overrides()).toHaveLength(1);
    expect(registry.override(DST, SRC, 'pipelines')).toBeUndefined();
  });

  it('[API-020] the computed capability matrix matches the committed snapshot', async () => {
    await expect(`${JSON.stringify(project(matrix), null, 2)}\n`).toMatchFileSnapshot(
      './__snapshots__/capability-matrix.txt',
    );
  });

  it('[API-020] marks the override only on the pipelines cell of the overridden pair', () => {
    const flagged = matrix.rows.flatMap((r) =>
      r.cells.filter((c) => c.override).map((c) => `${r.facet} ${c.source} -> ${c.target}`),
    );
    expect(flagged).toEqual([`pipelines ${SRC} -> ${DST}`]);
  });
});

/**
 * Rows of the mapping tables in docs/spec/05-facets.md that capabilities can express. Where the
 * declared capabilities and the table disagree, the test asserts what the code declares and the
 * comment names the table's value; the disagreements are listed in docs/adr/0260.
 */
describe('capability matrix against the mapping tables in 05-facets', () => {
  it('[API-020] FAC-GIT-003: git-refs is read on the source and exact', () => {
    expect(cell('git-refs')).toMatchObject({ fidelity: 'exact', read: true });
  });

  it('[API-020] FAC-SET: repository-settings is exact (forking is decided at read time, FAC-SET-002)', () => {
    expect(cell('repository-settings')).toMatchObject({ fidelity: 'exact', write: true });
  });

  it('[API-020] FAC-MRG-001: allowed is constrained on the target (ff-only is lossy)', () => {
    expect(field('merge-settings', '/allowed')?.fidelity).toBe('lossy');
  });

  it('[API-020] FAC-BRR-002: enforcement and approvals above 6 are lossy', () => {
    expect(field('branch-rules', '/rules/enforcement')?.fidelity).toBe('lossy');
    expect(field('branch-rules', '/rules/changeRequest/minApprovals')?.fidelity).toBe('lossy');
  });

  it('[API-020] FAC-BRR-002: minPassingBuilds is unsupported', () => {
    expect(field('branch-rules', '/rules/changeRequest/minPassingBuilds')?.fidelity).toBe(
      'unsupported',
    );
  });

  it('[API-020] FAC-BRR-002: forcePushExempt is representable (translated, so exact as a ceiling)', () => {
    expect(field('branch-rules', '/rules/forcePushExempt')?.fidelity).toBe('exact');
  });

  it('[API-020] FAC-BRR-002: deletionExempt is not representable', () => {
    // The table says lossy (`branch-rules.exemptions-dropped`); the adapter declares unsupported.
    expect(field('branch-rules', '/rules/deletionExempt')?.fidelity).toBe('unsupported');
  });

  it('[API-020] FAC-BRR-002: restrictMerges is not representable', () => {
    // The table says lossy (`branch-rules.merge-restriction-as-push`); the adapter declares unsupported.
    expect(field('branch-rules', '/rules/restrictMerges')?.fidelity).toBe('unsupported');
  });

  it('[API-020] FAC-BRR-002: requireTasksResolved is lossy in the table but not declared', () => {
    expect(field('branch-rules', '/rules/changeRequest/requireTasksResolved')).toBeUndefined();
  });

  it('[API-020] FAC-WEB-003: the webhook secret is unreadable', () => {
    // The target declares it unreadable (write-only); the source declares nothing, so the cell is exact.
    expect(field('webhooks', '/hooks/secret')?.target).toEqual({ kind: 'unreadable' });
    expect(cell('webhooks').fidelity).toBe('exact');
  });

  it('[API-020] FAC-ENV: category has no target equivalent', () => {
    // The table says lossy (`environments.category-dropped`, accepted by default); the adapter declares unsupported.
    expect(field('environments', '/environments/category')?.fidelity).toBe('unsupported');
  });

  it('[API-020] FAC-SEC-001: secrets are never written, so the target has no driver write', () => {
    expect(cell('secrets')).toMatchObject({ read: true, write: false });
    expect(cell('org-secrets').write).toBe(false);
  });

  it('[API-020] FAC-PIP-003, FAC-CRQ, FAC-END: delivered by Change Request, invitation or detection, so no driver write', () => {
    for (const facet of ['pipelines', 'change-requests', 'members']) {
      expect(cell(facet).write, facet).toBe(false);
    }
  });

  it('[API-020] FAC-EXT-001: extras is detect-only, so the target declaring nothing does not matter', () => {
    expect(matrix.rows.find((r) => r.facet === 'extras')?.inScope).toBe(false);
    expect(cell('extras')).toMatchObject({ fidelity: 'exact', read: true, write: false });
  });

  it('[API-020] the reverse direction cannot write: the source adapter is read-only everywhere', () => {
    for (const row of matrix.rows) {
      expect(cell(row.facet, DST, SRC).write, row.facet).toBe(false);
    }
  });
});
