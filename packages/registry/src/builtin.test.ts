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
 * Every row of the mapping tables in docs/spec/05-facets.md that is lossy, unreadable or
 * unsupported for the pair, as the fidelity the matrix must show for Bitbucket Cloud to GitHub
 * (ADR-0261: the static matrix is a worst-case ceiling, so a row that is lossy whether or not the
 * data triggers it is declared `constrained`). Read-time rows (`/forking` on an organization that
 * forbids private forks) stay dynamic, and `translated` is never produced statically.
 */
const TABLE: readonly { facet: string; path: string; fidelity: string; row: string }[] = [
  {
    facet: 'repository-settings',
    path: '/description',
    fidelity: 'lossy',
    row: 'FAC-SET description truncated at 350',
  },
  {
    facet: 'repository-settings',
    path: '/forking',
    fidelity: 'exact',
    row: 'FAC-SET forking (public-repo lossy case and org policy are read-time, ADR-0231)',
  },
  {
    facet: 'merge-settings',
    path: '/allowed',
    fidelity: 'lossy',
    row: 'FAC-MRG-001 ff-only as rebase',
  },
  {
    facet: 'branch-rules',
    path: '/rules/enforcement',
    fidelity: 'lossy',
    row: 'FAC-BRR-002 advisory-enforced',
  },
  {
    facet: 'branch-rules',
    path: '/rules/restrictMerges',
    fidelity: 'lossy',
    row: 'FAC-BRR-002 merge-restriction-as-push',
  },
  {
    facet: 'branch-rules',
    path: '/rules/forcePushExempt',
    fidelity: 'exact',
    row: 'FAC-BRR-002 translated',
  },
  {
    facet: 'branch-rules',
    path: '/rules/deletionExempt',
    fidelity: 'lossy',
    row: 'FAC-BRR-002 exemptions-dropped',
  },
  {
    facet: 'branch-rules',
    path: '/rules/changeRequest/minApprovals',
    fidelity: 'lossy',
    row: 'FAC-BRR-002 approvals-capped above 6',
  },
  {
    facet: 'branch-rules',
    path: '/rules/changeRequest/requireTasksResolved',
    fidelity: 'lossy',
    row: 'FAC-BRR-002 tasks-as-conversations',
  },
  {
    facet: 'branch-rules',
    path: '/rules/changeRequest/minPassingBuilds',
    fidelity: 'unsupported',
    row: 'FAC-BRR-002 configure-status-checks',
  },
  {
    facet: 'webhooks',
    path: '/hooks/secret',
    fidelity: 'unreadable',
    row: 'FAC-WEB-003 secret unreadable',
  },
  {
    facet: 'org-webhooks',
    path: '/hooks/secret',
    fidelity: 'unreadable',
    row: 'FAC-END secret rules as FAC-WEB',
  },
  {
    facet: 'secrets',
    path: '/secrets/value',
    fidelity: 'unreadable',
    row: 'FAC-VAR-001, FAC-SEC-001 values unreadable',
  },
  {
    facet: 'org-secrets',
    path: '/secrets/value',
    fidelity: 'unreadable',
    row: 'FAC-END org-secrets values never read',
  },
  {
    facet: 'branch-rules',
    path: '/rules/pattern',
    fidelity: 'lossy',
    row: 'FAC-BRR-003 pattern-approximated, patterns-merged, overlap-unresolved',
  },
  {
    facet: 'variables',
    path: '/variables/name',
    fidelity: 'lossy',
    row: 'FAC-VAR-003 uppercase-names',
  },
  {
    facet: 'org-variables',
    path: '/variables/name',
    fidelity: 'lossy',
    row: 'FAC-END org-variables.uppercase-names',
  },
  { facet: 'webhooks', path: '/hooks/events', fidelity: 'lossy', row: 'FAC-WEB-001 event-dropped' },
  {
    facet: 'org-webhooks',
    path: '/hooks/events',
    fidelity: 'lossy',
    row: 'FAC-END org-webhooks.event-dropped',
  },
  {
    facet: 'code-ownership',
    path: '/owners',
    fidelity: 'lossy',
    row: 'FAC-COD default-reviewers-as-codeowners',
  },
  {
    facet: 'environments',
    path: '/environments/category',
    fidelity: 'lossy',
    row: 'FAC-ENV category-dropped',
  },
];

/** Facets with a driver write on the target. The others are delivered otherwise (FAC-SEC-001, FAC-PIP-003, FAC-CRQ, FAC-END, FAC-GIT). */
const WRITTEN = new Set([
  'repository-settings',
  'merge-settings',
  'access-control',
  'branch-rules',
  'webhooks',
  'deploy-keys',
  'variables',
  'environments',
  'code-ownership',
  'teams',
  'org-variables',
  'org-webhooks',
]);

describe('capability matrix against the mapping tables in 05-facets', () => {
  it.each(TABLE)('[API-020] $facet $path is $fidelity ($row)', ({ facet, path, fidelity }) => {
    expect(field(facet, path)?.fidelity).toBe(fidelity);
  });

  it('[API-020] the matrix is a static ceiling', () => {
    expect(matrix.ceiling).toBe('static');
  });

  it('[API-020] marker paths on the source side are pinned: they exist only so the matrix can show unreadable values', () => {
    const markers = matrix.rows.flatMap((r) =>
      cell(r.facet)
        .fields.filter((f) => f.source.kind !== 'supported')
        .map((f) => `${r.facet} ${f.path}`),
    );
    expect(markers.sort()).toEqual([
      'org-secrets /secrets/value',
      'org-webhooks /hooks/secret',
      'secrets /secrets/value',
      'webhooks /hooks/secret',
    ]);
  });

  it('[FAC-WEB-001] no declared constraint on /hooks/events starts with only:, the translator reads that at run time', () => {
    for (const facet of ['webhooks', 'org-webhooks']) {
      const t = field(facet, '/hooks/events')?.target;
      expect(t?.kind === 'constrained' && t.constraint.startsWith('only:')).toBe(false);
    }
  });

  it('[API-020] a facet cell is the worst of its table rows, and exact where the tables list none', () => {
    const order = ['exact', 'lossy', 'unreadable', 'unsupported'];
    for (const row of matrix.rows) {
      const rows = TABLE.filter((t) => t.facet === row.facet).map((t) => t.fidelity);
      const worst = rows.reduce((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'exact');
      expect(cell(row.facet).fidelity, row.facet).toBe(worst);
    }
  });

  it('[API-020] no field is declared that the tables do not list', () => {
    const listed = new Set(TABLE.map((t) => `${t.facet} ${t.path}`));
    const declared = matrix.rows.flatMap((r) =>
      cell(r.facet).fields.map((f) => `${r.facet} ${f.path}`),
    );
    expect(declared.filter((d) => !listed.has(d))).toEqual([]);
  });

  it('[API-020] driver writes agree with the delivery described in the tables', () => {
    for (const row of matrix.rows) {
      if (row.facet === 'extras') continue;
      expect(cell(row.facet).write, row.facet).toBe(WRITTEN.has(row.facet));
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
