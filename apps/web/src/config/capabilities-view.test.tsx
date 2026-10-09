// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, configure, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, mockApi } from '../test-api.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import type { CapabilityMatrix, Fidelity, MatrixField } from './api.ts';
import { CapabilityMatrixView, cellFor, pairsOf } from './capabilities-view.tsx';

vi.setConfig({ testTimeout: 30_000 });
// The machine is shared by parallel agents: async queries get more than the 1 s default (UI tests).
configure({ asyncUtilTimeout: 10_000 });

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const cell = (source: string, target: string, fidelity: Fidelity, fields: MatrixField[] = []) => ({
  source,
  target,
  fidelity,
  read: true,
  write: fidelity !== 'unsupported',
  override: false,
  fields,
});

const MATRIX: CapabilityMatrix = {
  ceiling: 'static',
  adapters: ['bitbucket', 'github'],
  rows: [
    {
      facet: 'branch-rules',
      scope: 'repository',
      inScope: true,
      cells: [
        cell('bitbucket', 'github', 'lossy', [
          {
            path: 'restrictions.users',
            source: { kind: 'exact' },
            target: { kind: 'constrained' },
            fidelity: 'lossy',
          },
          { path: 'name', source: { kind: 'exact' }, target: { kind: 'exact' }, fidelity: 'exact' },
        ]),
        cell('github', 'bitbucket', 'unsupported'),
      ],
    },
    {
      facet: 'repository-settings',
      scope: 'repository',
      inScope: false,
      cells: [cell('bitbucket', 'github', 'exact')],
    },
  ],
};

beforeEach(() => {
  installMatchMedia(false);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('[UI-033] capability matrix', () => {
  it('[UI-033] lists the ordered pairs and the fidelity of each Facet for them', () => {
    expect(pairsOf(MATRIX)).toEqual([
      { source: 'bitbucket', target: 'github' },
      { source: 'github', target: 'bitbucket' },
    ]);
    expect(
      cellFor(MATRIX.rows[0]?.cells ?? [], { source: 'github', target: 'bitbucket' })?.fidelity,
    ).toBe('unsupported');
    expect(cellFor([], { source: 'x', target: 'y' })).toBeUndefined();
  });

  it("[UI-033] shows fidelity as text, the Facet scope and the Routes' accepted lossy policies", async () => {
    mockApi((url) => (url.pathname === '/api/v1/capability-matrix' ? json(MATRIX) : undefined), {
      route: [
        {
          id: 'r1',
          defaults: {},
          policies: { acceptLossy: ['branch-rules.advisory-enforced'] },
          sourceEndpointId: 'e-gh',
          targetEndpointId: 'e-bb',
          sourceEndpoint: { providerType: 'github' },
          targetEndpoint: { providerType: 'bitbucket' },
        },
        {
          id: 'r2',
          defaults: {},
          policies: { acceptLossy: [] },
          sourceEndpointId: 'e-bb',
          targetEndpointId: 'e-gh',
          sourceEndpoint: { providerType: 'bitbucket' },
          targetEndpoint: { providerType: 'github' },
        },
      ],
    });
    renderWithApp(<CapabilityMatrixView />, fresh());
    expect((await screen.findAllByText('branch-rules')).length).toBeGreaterThan(0);
    expect(screen.getByText('Repository scope · not in scope')).toBeTruthy();
    expect(screen.getAllByText('Lossy').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Unsupported').length).toBeGreaterThan(0);
    expect(screen.getByText('Read yes, write no')).toBeTruthy();
    expect(screen.queryByText('name')).toBeNull();

    expect(await screen.findByText('branch-rules.advisory-enforced')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
    // Each Route shows its pair and Endpoints; the first Route's pair is preselected.
    expect(screen.getByText('e-gh to e-bb')).toBeTruthy();
    expect(screen.getByText('e-bb to e-gh')).toBeTruthy();
    const pair = screen.getByRole('combobox', { name: 'Source and target' }) as HTMLInputElement;
    expect(pair.closest('.ant-select')?.textContent).toContain('github to bitbucket');
    expect(screen.queryByText('restrictions.users')).toBeNull();
  });

  it('[UI-033] a Facet that is exact everywhere has no field to list', async () => {
    mockApi(
      (url) =>
        url.pathname === '/api/v1/capability-matrix'
          ? json({ ...MATRIX, rows: [MATRIX.rows[1]] })
          : undefined,
      { route: [] },
    );
    renderWithApp(<CapabilityMatrixView />, fresh());
    expect(await screen.findByText('Every field is exact for this pair.')).toBeTruthy();
    expect(screen.getByText('No Routes are configured.')).toBeTruthy();
  });
});
