// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { GroupMappingView } from './group-mapping-view.tsx';
import { IdentityMappingView } from './identity-mapping-view.tsx';

const ref = (id: string, login: string, email: string | null = null) => ({
  id,
  providerId: `{${id}}`,
  login,
  displayName: login.toUpperCase(),
  email,
});

const mapping = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  method: null,
  confidence: null,
  decidedAt: null,
  decidedBy: null,
  reason: null,
  source: ref(`s-${id}`, `user-${id}`, `${id}@example.test`),
  target: null,
  ...extra,
});

// antd tables and drawers are slow to render in jsdom, more so when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: URL, init?: RequestInit) => Response | undefined;
let calls: { url: URL; init?: RequestInit }[] = [];

function mockApi(handler: Handler) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.pathname === '/api/v1/routes') return json({ items: [{ id: 'r1' }, { id: 'r2' }] });
      return (
        handler(url, init) ?? json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404)
      );
    }),
  );
}

const posts = () => calls.filter((c) => c.init?.method === 'POST');

beforeEach(() => {
  installMatchMedia(false);
  // jsdom has no ResizeObserver; antd's Table, Select and Drawer observe sizes.
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

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('[UI-027] identity mapping page', () => {
  const rows = [
    mapping('a', 'suggested', {
      method: 'login',
      confidence: 0.9,
      target: ref('t-a', 'a-gh'),
    }),
    mapping('b', 'unmapped'),
    mapping('c', 'excluded', { method: 'manual', reason: 'Left the company' }),
    mapping('d', 'confirmed', {
      method: 'email',
      target: ref('t-d', 'd-gh'),
      decidedAt: '2026-10-01T10:00:00.000Z',
      decidedBy: 'Ada',
    }),
  ];

  const listHandler: Handler = (url, init) => {
    if (url.pathname === '/api/v1/routes/r1/identity-mappings' && init?.method !== 'POST') {
      return json({ items: rows, nextCursor: null });
    }
    return undefined;
  };

  it('[UI-027] shows source identities with status, method, suggested target and the actions that fit', async () => {
    mockApi(listHandler);
    renderWithApp(<IdentityMappingView />, fresh());
    expect(await screen.findByText('USER-A')).toBeTruthy();
    const body = screen.getAllByRole('row');
    const rowOf = (text: string) => body.find((r) => within(r).queryByText(text)) as HTMLElement;

    const suggested = rowOf('USER-A');
    expect(within(suggested).getByText('Suggested')).toBeTruthy();
    expect(within(suggested).getByText('Login')).toBeTruthy();
    expect(within(suggested).getByText('A-GH')).toBeTruthy();
    expect(within(suggested).getByText('Confidence 90%')).toBeTruthy();
    expect(within(suggested).getByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(within(suggested).getByRole('button', { name: 'Change target' })).toBeTruthy();
    expect(within(suggested).getByRole('button', { name: 'Exclude' })).toBeTruthy();
    expect(within(suggested).getByRole('button', { name: 'Unmap' })).toBeTruthy();

    const unmapped = rowOf('USER-B');
    expect(within(unmapped).queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(within(unmapped).queryByRole('button', { name: 'Unmap' })).toBeNull();

    const excluded = rowOf('USER-C');
    expect(within(excluded).getByText('Reason: Left the company')).toBeTruthy();
    expect(within(excluded).queryByRole('button', { name: 'Exclude' })).toBeNull();
    expect(within(excluded).getByRole('button', { name: 'Unmap' })).toBeTruthy();

    const confirmed = rowOf('USER-D');
    expect(within(confirmed).queryByRole('button', { name: 'Confirm' })).toBeNull();
    // Dates go through formatDateTime (UI-001); a decided row names the decider.
    expect(within(confirmed).getByText(/2026.*by Ada/)).toBeTruthy();
  });

  it('[UI-027] confirm posts the decision and refetches the list', async () => {
    mockApi((url, init) => {
      if (url.pathname.endsWith('/a/confirm')) return json({ ...rows[0], status: 'confirmed' });
      return listHandler(url, init);
    });
    renderWithApp(<IdentityMappingView />, fresh());
    await screen.findByText('USER-A');
    const before = calls.filter((c) => c.url.pathname.endsWith('/identity-mappings')).length;
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm' })[0] as HTMLElement);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/routes/r1/identity-mappings/a/confirm');
    await waitFor(() =>
      expect(
        calls.filter((c) => c.url.pathname.endsWith('/identity-mappings')).length,
      ).toBeGreaterThan(before),
    );
  });

  it('[UI-027] excluding needs a reason and sends it', async () => {
    mockApi((url, init) => {
      if (url.pathname.endsWith('/b/exclude')) return json({ ...rows[1], status: 'excluded' });
      return listHandler(url, init);
    });
    renderWithApp(<IdentityMappingView />, fresh());
    await screen.findByText('USER-B');
    const row = screen
      .getAllByRole('row')
      .find((r) => within(r).queryByText('USER-B')) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Exclude' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Exclude' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '   ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: ' Left ' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/routes/r1/identity-mappings/b/exclude');
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({ reason: 'Left' });
  });

  it('[UI-027] change target searches the target identities and confirms the chosen one', async () => {
    mockApi((url, init) => {
      if (url.pathname === '/api/v1/routes/r1/target-identities') {
        return json({ items: [ref('t-x', 'x-gh', 'x@example.test')] });
      }
      if (url.pathname.endsWith('/b/confirm')) return json({ ...rows[1], status: 'confirmed' });
      return listHandler(url, init);
    });
    renderWithApp(<IdentityMappingView />, fresh());
    await screen.findByText('USER-B');
    const row = screen
      .getAllByRole('row')
      .find((r) => within(r).queryByText('USER-B')) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Change target' }));
    const dialog = await screen.findByRole('dialog');
    const combo = within(dialog).getByRole('combobox');
    fireEvent.mouseDown(combo);
    const option = await screen.findByText('X-GH / x@example.test');
    fireEvent.click(option);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm target' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({ targetIdentityId: 't-x' });
  });

  it('[UI-027] unmap posts without a body field', async () => {
    mockApi((url, init) => {
      if (url.pathname.endsWith('/d/unmap')) return json({ ...rows[3], status: 'unmapped' });
      return listHandler(url, init);
    });
    renderWithApp(<IdentityMappingView />, fresh());
    await screen.findByText('USER-D');
    const row = screen
      .getAllByRole('row')
      .find((r) => within(r).queryByText('USER-D')) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Unmap' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({});
  });

  it('[UI-027] filters by status and by search text through the API', async () => {
    mockApi(listHandler);
    renderWithApp(<IdentityMappingView />, fresh());
    await screen.findByText('USER-A');
    const search = screen.getByLabelText('Search source identities');
    fireEvent.change(search, { target: { value: 'alice' } });
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter', keyCode: 13 });
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.pathname.endsWith('/identity-mappings') &&
            c.url.searchParams.get('q') === 'alice',
        ),
      ).toBe(true),
    );
  });

  it('[UI-027] a failed load shows the problem text, not the raw code', async () => {
    mockApi((url) =>
      url.pathname.endsWith('/identity-mappings')
        ? json({ type: 'x', title: 'x', status: 403, code: 'forbidden' }, 403)
        : undefined,
    );
    renderWithApp(<IdentityMappingView />, fresh());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your role does not allow this action');
  });

  it('[UI-027] loads more with the cursor', async () => {
    mockApi((url) => {
      if (!url.pathname.endsWith('/identity-mappings')) return undefined;
      return url.searchParams.get('cursor')
        ? json({ items: [rows[1]], nextCursor: null })
        : json({ items: [rows[0]], nextCursor: 'a' });
    });
    renderWithApp(<IdentityMappingView />, fresh());
    await screen.findByText('USER-A');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('USER-B');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('[UI-027] CSV import drawer', () => {
  const report = (overrides: Record<string, unknown> = {}) => ({
    dryRun: true,
    ok: true,
    fileErrors: [],
    rows: [
      {
        line: 2,
        source: 'alice',
        target: 'alice-gh',
        action: 'map',
        ok: true,
        errors: [],
        outcome: 'mapped',
      },
    ],
    summary: { total: 1, valid: 1, invalid: 0, mapped: 1, invited: 0, excluded: 0, unchanged: 0 },
    ...overrides,
  });

  const open = async () => {
    renderWithApp(<IdentityMappingView />, fresh());
    await screen.findByText('USER-A');
    fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }));
    return await screen.findByRole('dialog');
  };
  const listOnly: Handler = (url, init) =>
    url.pathname.endsWith('/identity-mappings') && init?.method !== 'POST'
      ? json({ items: [mapping('a', 'unmapped')], nextCursor: null })
      : undefined;

  it('[UI-027] checking a file sends a dry run, shows the result per row and then allows Apply', async () => {
    mockApi((url, init) => {
      if (url.pathname.endsWith('/import')) {
        return url.searchParams.get('dryRun') === 'true'
          ? json(report())
          : json(report({ dryRun: false }));
      }
      return listOnly(url, init);
    });
    const dialog = await open();
    const apply = within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('CSV text'), {
      target: { value: 'source,target,action\nalice,alice-gh,map\n' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check file' }));
    expect(await within(dialog).findByText(/1 row is valid/)).toBeTruthy();
    expect(within(dialog).getByText('Will map')).toBeTruthy();
    const imports = posts();
    expect(imports).toHaveLength(1);
    expect(imports[0]?.url.searchParams.get('dryRun')).toBe('true');
    expect(imports[0]?.init?.body).toBe('source,target,action\nalice,alice-gh,map\n');
    expect(new Headers(imports[0]?.init?.headers).get('content-type')).toBe('text/csv');
    await waitFor(() => expect(apply.disabled).toBe(false));

    // Editing the text invalidates the check.
    fireEvent.change(within(dialog).getByLabelText('CSV text'), { target: { value: 'changed' } });
    expect(apply.disabled).toBe(true);
  });

  it('[UI-027] apply sends dryRun=false and reports what was done', async () => {
    mockApi((url, init) => {
      if (url.pathname.endsWith('/import')) {
        return url.searchParams.get('dryRun') === 'true'
          ? json(report())
          : json(
              report({
                dryRun: false,
                summary: {
                  total: 1,
                  valid: 1,
                  invalid: 0,
                  mapped: 1,
                  invited: 0,
                  excluded: 0,
                  unchanged: 0,
                },
              }),
            );
      }
      return listOnly(url, init);
    });
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('CSV text'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check file' }));
    await within(dialog).findByText(/1 row is valid/);
    const apply = within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));
    fireEvent.click(apply);
    expect(await within(dialog).findByText(/Applied: 1 mapped, 0 invited/)).toBeTruthy();
    expect(posts().map((p) => p.url.searchParams.get('dryRun'))).toEqual(['true', 'false']);
  });

  it('[UI-027] row errors are listed per line and Apply stays disabled', async () => {
    mockApi((url, init) =>
      url.pathname.endsWith('/import')
        ? json(
            report({
              ok: false,
              rows: [
                {
                  line: 2,
                  source: "'-dash",
                  target: "'@evil",
                  action: 'map',
                  ok: false,
                  errors: ['formula_prefix'],
                  outcome: null,
                },
                {
                  line: 3,
                  source: 'nobody',
                  target: 'x',
                  action: 'map',
                  ok: false,
                  errors: ['source_not_found', 'brand_new_code'],
                  outcome: null,
                },
              ],
              summary: {
                total: 2,
                valid: 0,
                invalid: 2,
                mapped: 0,
                invited: 0,
                excluded: 0,
                unchanged: 0,
              },
            }),
          )
        : listOnly(url, init),
    );
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('CSV text'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check file' }));
    expect(await within(dialog).findByText(/2 problems found/)).toBeTruthy();
    expect(within(dialog).getByText('The target starts with =, +, - or @.')).toBeTruthy();
    expect(within(dialog).getByText('No source identity matches.')).toBeTruthy();
    // A code this version does not know is shown as is rather than hiding the problem.
    expect(within(dialog).getByText('brand_new_code')).toBeTruthy();
    // Echoed cells arrive neutralized and are shown as received.
    expect(within(dialog).getByText("'-dash")).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('[UI-027] file-level errors such as a wrong header are shown', async () => {
    mockApi((url, init) =>
      url.pathname.endsWith('/import')
        ? json(
            report({
              ok: false,
              fileErrors: ['header_invalid'],
              rows: [],
              summary: {
                total: 0,
                valid: 0,
                invalid: 0,
                mapped: 0,
                invited: 0,
                excluded: 0,
                unchanged: 0,
              },
            }),
          )
        : listOnly(url, init),
    );
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('CSV text'), { target: { value: 'a,b,c' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check file' }));
    const matches = await within(dialog).findAllByText(
      'The first line must be exactly: source,target,action.',
    );
    expect(matches.length).toBeGreaterThan(0);
  });

  it('[UI-027] a rejected apply says nothing was changed', async () => {
    mockApi((url, init) => {
      if (url.pathname.endsWith('/import')) {
        return url.searchParams.get('dryRun') === 'true'
          ? json(report())
          : json(
              {
                type: 'x',
                title: 'x',
                status: 422,
                code: 'validation_failed',
                errors: [{ path: 'line 2', message: 'source_not_found' }],
              },
              422,
            );
      }
      return listOnly(url, init);
    });
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText('CSV text'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check file' }));
    await within(dialog).findByText(/1 row is valid/);
    const apply = within(dialog).getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    await waitFor(() => expect(apply.disabled).toBe(false));
    fireEvent.click(apply);
    expect(await within(dialog).findByText(/nothing was changed/)).toBeTruthy();
  });

  it('[UI-027] reads a chosen file into the text box', async () => {
    mockApi(listOnly);
    const dialog = await open();
    const input = within(dialog).getByLabelText('CSV file') as HTMLInputElement;
    const file = new File(['source,target,action\n'], 'map.csv', { type: 'text/csv' });
    // jsdom's File has no text().
    Object.defineProperty(file, 'text', { value: async () => 'source,target,action\n' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect((within(dialog).getByLabelText('CSV text') as HTMLTextAreaElement).value).toBe(
        'source,target,action\n',
      ),
    );
  });
});

describe('[UI-028] team mapping page', () => {
  const group = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    status: 'unmapped',
    plannedSlug: id,
    collision: false,
    sourceGroup: { id: `s-${id}`, slug: id, name: id.toUpperCase(), memberCount: 3 },
    targetGroup: null,
    ...extra,
  });
  const groups = [
    group('devs', {
      status: 'suggested',
      targetGroup: { id: 't-devs', slug: 'devs', name: 'Devs', memberCount: 5 },
    }),
    group('ops', { collision: true }),
    group('qa', {
      status: 'confirmed',
      targetGroup: { id: 't-qa', slug: 'qa', name: 'Quality', memberCount: 1 },
    }),
  ];
  const handler: Handler = (url, init) =>
    url.pathname === '/api/v1/routes/r1/group-mappings' && init?.method !== 'POST'
      ? json({ items: groups })
      : undefined;

  it('[UI-028] shows planned slug, status, member counts, collisions and the actions that fit', async () => {
    mockApi(handler);
    renderWithApp(<GroupMappingView />, fresh());
    await screen.findByText('DEVS');
    const rowOf = (text: string) =>
      screen.getAllByRole('row').find((r) => within(r).queryByText(text)) as HTMLElement;
    const devs = rowOf('DEVS');
    expect(within(devs).getByText('Suggested')).toBeTruthy();
    expect(within(devs).getByText('3 members')).toBeTruthy();
    expect(within(devs).getByText('5 members')).toBeTruthy();
    expect(within(devs).getByRole('button', { name: 'Confirm' })).toBeTruthy();
    const ops = rowOf('OPS');
    expect(within(ops).getByText('Slug collision')).toBeTruthy();
    expect(within(ops).getByText('Team will be created')).toBeTruthy();
    expect(within(ops).queryByRole('button', { name: 'Confirm' })).toBeNull();
    const qa = rowOf('QA');
    expect(within(qa).getByText('1 member')).toBeTruthy();
    expect(within(qa).queryByRole('button', { name: 'Edit slug' })).toBeNull();
  });

  it('[UI-028] confirm posts to the group mapping', async () => {
    mockApi((url, init) =>
      url.pathname.endsWith('/devs/confirm')
        ? json({ ...groups[0], status: 'confirmed' })
        : handler(url, init),
    );
    renderWithApp(<GroupMappingView />, fresh());
    await screen.findByText('DEVS');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/routes/r1/group-mappings/devs/confirm');
  });

  it('[UI-028] editing the slug validates it before sending', async () => {
    mockApi((url, init) =>
      url.pathname.endsWith('/ops/rename')
        ? json({ ...groups[1], plannedSlug: 'site-ops' })
        : handler(url, init),
    );
    renderWithApp(<GroupMappingView />, fresh());
    await screen.findByText('OPS');
    const row = screen.getAllByRole('row').find((r) => within(r).queryByText('OPS')) as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Edit slug' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Team slug');
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: 'Bad Slug' } });
    expect(save.disabled).toBe(true);
    expect(within(dialog).getByText(/Use lowercase letters/)).toBeTruthy();
    fireEvent.change(input, { target: { value: 'site-ops' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({ plannedSlug: 'site-ops' });
  });

  it('[UI-028] a conflict from the API is shown with its problem text', async () => {
    mockApi((url, init) =>
      url.pathname.endsWith('/devs/confirm')
        ? json({ type: 'x', title: 'x', status: 409, code: 'conflict' }, 409)
        : handler(url, init),
    );
    renderWithApp(<GroupMappingView />, fresh());
    await screen.findByText('DEVS');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('conflicts with the current state');
  });

  it('[UI-028] says so when there are no Routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ items: [] })),
    );
    renderWithApp(<GroupMappingView />, fresh());
    expect(await screen.findByText(/There are no Routes yet/)).toBeTruthy();
  });
});
