// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { BatchView } from './batch-view.tsx';
import { InvitationsView } from './invitations-view.tsx';

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
      if (url.pathname === '/api/v1/routes') return json({ items: [{ id: 'r1' }] });
      return (
        handler(url, init) ?? json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404)
      );
    }),
  );
}
const posts = () => calls.filter((c) => c.init?.method === 'POST');
const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

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

const ref = (id: string, login: string, email: string | null = null) => ({
  id,
  providerId: `acct-${id}`,
  login,
  displayName: login.toUpperCase(),
  email,
});

const counts = (over: Record<string, number> = {}) => ({
  selected: 0,
  deselected: 0,
  sent: 0,
  accepted: 0,
  failed: 0,
  expired: 0,
  ...over,
});

const batch = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'b1',
  routeId: 'r1',
  status,
  createdAt: '2026-10-01T10:00:00.000Z',
  createdBy: 'Ada',
  approvedBy: null,
  approvedAt: null,
  nextAttemptAt: null,
  selectionToken: 'tok-1',
  seatPreview: { toInvite: 2, seatsTotal: null, seatsFilled: null, projectedFilled: null },
  counts: counts({ selected: 2 }),
  ...over,
});

const item = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  status,
  email: `${id}@example.test`,
  teamSlugs: ['devs'],
  source: ref(`s-${id}`, `user-${id}`, `${id}@example.test`),
  error: null,
  deselectReason: null,
  sentAt: null,
  providerIdKnown: true,
  mappingId: `m-${id}`,
  suggestions: [],
  ...over,
});

describe('[UI-029] invitation batch list', () => {
  const candidates = {
    items: [
      { identity: ref('i1', 'ann', 'ann@example.test'), teamSlugs: ['devs'] },
      { identity: ref('i2', 'ben', 'ben@example.test'), teamSlugs: [] },
    ],
    nextCursor: null,
  };
  const handler: Handler = (url, init) => {
    if (url.pathname === '/api/v1/invitation-batches') {
      return json({
        items: [batch('approved', { approvedBy: 'Ada', approvedAt: '2026-10-01T11:00:00.000Z' })],
        nextCursor: null,
      });
    }
    if (url.pathname === '/api/v1/routes/r1/invitation-candidates') return json(candidates);
    if (url.pathname === '/api/v1/routes/r1/invitation-batches' && init?.method === 'POST') {
      return json(batch('draft'), 201);
    }
    return undefined;
  };

  it('[UI-029] lists batches with status, counts and the unknown seat preview, linking to the detail', async () => {
    mockApi(handler);
    renderWithApp(<InvitationsView />, fresh());
    const link = await screen.findByRole('link', { name: /Batch of/ });
    expect(link.getAttribute('href')).toBe('/people/invitations/b1');
    const row = screen
      .getAllByRole('row')
      .find((r) => within(r).queryByRole('link')) as HTMLElement;
    expect(within(row).getByText('Approved')).toBeTruthy();
    expect(within(row).getByText(/2 selected, 0 sent/)).toBeTruthy();
    expect(within(row).getByText('2 invitations; seats unknown')).toBeTruthy();
    expect(within(row).getByText(/by Ada/)).toBeTruthy();
    expect(screen.getByText(/Nobody is invited unless an operator approves a batch/)).toBeTruthy();
  });

  it('[UI-029] drafts a batch from the people picked; nothing is sent', async () => {
    mockApi(handler);
    renderWithApp(<InvitationsView />, fresh());
    await screen.findByRole('link', { name: /Batch of/ });
    fireEvent.click(screen.getByRole('button', { name: /New batch/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('ann@example.test');
    const draftPicked = within(dialog).getByRole('button', {
      name: /Draft a batch from the selection/,
    });
    expect((draftPicked as HTMLButtonElement).disabled).toBe(true);
    const boxes = within(dialog).getAllByRole('checkbox');
    fireEvent.click(boxes[1] as HTMLElement);
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Draft a batch of 1 person' }),
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/routes/r1/invitation-batches');
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({ identityIds: ['i1'] });
  });

  it('[UI-029] drafts a batch from all candidates in one step', async () => {
    mockApi(handler);
    renderWithApp(<InvitationsView />, fresh());
    await screen.findByRole('link', { name: /Batch of/ });
    fireEvent.click(screen.getByRole('button', { name: /New batch/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      await within(dialog).findByRole('button', { name: 'Draft a batch of everyone listed' }),
    );
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({ all: true });
  });

  it('[UI-029] says so when there are no batches', async () => {
    mockApi((url) =>
      url.pathname === '/api/v1/invitation-batches'
        ? json({ items: [], nextCursor: null })
        : undefined,
    );
    renderWithApp(<InvitationsView />, fresh());
    expect(await screen.findByText('No invitation batches yet.')).toBeTruthy();
  });
});

describe('[UI-029] invitation batch detail', () => {
  const draftDetail = {
    batch: batch('draft'),
    items: [item('a', 'selected'), item('b', 'deselected', { deselectReason: 'Contractor' })],
    nextCursor: null,
  };
  const rowOf = (text: string) =>
    screen.getAllByRole('row').find((r) => within(r).queryByText(text)) as HTMLElement;

  it('[UI-029] a draft shows the seat preview, leaves an entry out only with a reason, and includes it again', async () => {
    mockApi((url, init) => {
      if (url.pathname === '/api/v1/invitation-batches/b1' && init?.method !== 'POST') {
        return json(draftDetail);
      }
      if (init?.method === 'POST') return json({ status: 'deselected' });
      return undefined;
    });
    renderWithApp(<BatchView batchId="b1" />, fresh());
    expect(await screen.findByText('USER-A')).toBeTruthy();
    expect(screen.getByText('2 invitations; seats unknown')).toBeTruthy();
    expect(within(rowOf('USER-B')).getByText('Reason: Contractor')).toBeTruthy();

    fireEvent.click(within(rowOf('USER-A')).getByRole('button', { name: 'Leave out' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Leave out' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: '  ' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: ' Left ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/invitation-batches/b1/items/a/deselect');
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({ reason: 'Left' });

    fireEvent.click(within(rowOf('USER-B')).getByRole('button', { name: 'Include again' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]?.url.pathname).toBe('/api/v1/invitation-batches/b1/items/b/select');
  });

  it('[UI-029] approving asks for confirmation with the final count and sends it', async () => {
    mockApi((url, init) => {
      if (url.pathname === '/api/v1/invitation-batches/b1' && init?.method !== 'POST') {
        return json(draftDetail);
      }
      if (url.pathname.endsWith('/approve')) {
        return json({ approved: 2, dropped: 0, batch: batch('approved') }, 202);
      }
      return undefined;
    });
    renderWithApp(<BatchView batchId="b1" />, fresh());
    await screen.findByText('USER-A');
    fireEvent.click(screen.getByRole('button', { name: 'Approve batch' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(/2 invitations will be sent to the target organization/),
    ).toBeTruthy();
    expect(posts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and send 2' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/invitation-batches/b1/approve');
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({
      expectedCount: 2,
      expectedToken: 'tok-1',
    });
  });

  it('[UI-029] an approved batch is read-only and shows the status of every invitation', async () => {
    mockApi((url, init) => {
      if (url.pathname === '/api/v1/invitation-batches/b1' && init?.method !== 'POST') {
        return json({
          batch: batch('partial', {
            approvedBy: 'Ada',
            approvedAt: '2026-10-01T11:00:00.000Z',
            nextAttemptAt: '2026-10-02T11:00:00.000Z',
            counts: counts({ sent: 1, failed: 1, deselected: 1 }),
            seatPreview: { toInvite: 2, seatsTotal: 25, seatsFilled: 20, projectedFilled: 22 },
          }),
          items: [
            item('a', 'sent', { sentAt: '2026-10-01T12:00:00.000Z' }),
            item('b', 'failed', { error: 'invalid (422)' }),
            item('c', 'deselected', { deselectReason: 'Contractor' }),
            item('d', 'sent', { sentAt: '2026-10-01T12:00:00.000Z', providerIdKnown: false }),
          ],
          nextCursor: null,
        });
      }
      if (init?.method === 'POST') return json({ queued: true }, 202);
      return undefined;
    });
    renderWithApp(<BatchView batchId="b1" />, fresh());
    await screen.findByText('USER-A');
    expect(
      screen.getByText('2 invitations; 20 seats used of 25, 22 after sending of 25'),
    ).toBeTruthy();
    expect(screen.getByText(/limited the number of invitations/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve batch' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave out' })).toBeNull();
    expect(within(rowOf('USER-A')).getByText('Invitation sent')).toBeTruthy();
    expect(within(rowOf('USER-B')).getByText('Failed')).toBeTruthy();
    expect(within(rowOf('USER-B')).getByText('Problem: invalid (422)')).toBeTruthy();

    fireEvent.click(within(rowOf('USER-A')).getByRole('button', { name: 'Revoke invitation' }));
    const dialog = await screen.findByRole('dialog');
    // An entry with a recorded invitation needs no warning.
    expect(within(dialog).queryByText(/No invitation is recorded/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/invitation-batches/b1/items/a/revoke');

    // An entry resolved as invited has no recorded invitation: the dialog says what a miss does.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within(rowOf('USER-D')).getByRole('button', { name: 'Revoke invitation' }));
    const warned = await screen.findByRole('dialog');
    expect(within(warned).getByText(/released and can be invited again/)).toBeTruthy();
  });

  it('[UI-029] a sent entry offers the new members that might be the invitee; an operator confirms', async () => {
    mockApi((url, init) => {
      if (url.pathname === '/api/v1/invitation-batches/b1' && init?.method !== 'POST') {
        return json({
          batch: batch('sent', { counts: counts({ sent: 1 }) }),
          items: [item('a', 'sent', { suggestions: [ref('t1', 'new-member')] })],
          nextCursor: null,
        });
      }
      if (init?.method === 'POST') return json({});
      return undefined;
    });
    renderWithApp(<BatchView batchId="b1" />, fresh());
    await screen.findByText('USER-A');
    fireEvent.click(screen.getByRole('button', { name: 'This is NEW-MEMBER' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/routes/r1/identity-mappings/m-a/confirm');
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({ targetIdentityId: 't1' });
  });

  it('[UI-029] an entry with an unknown outcome stays held until the operator says what happened', async () => {
    mockApi((url, init) => {
      if (url.pathname === '/api/v1/invitation-batches/b1' && init?.method !== 'POST') {
        return json({
          batch: batch('partial', { counts: counts({ unknown: 1 }) }),
          items: [item('a', 'unknown', { error: 'unknown_outcome' })],
          nextCursor: null,
        });
      }
      if (init?.method === 'POST') return json({ status: 'sent' });
      return undefined;
    });
    renderWithApp(<BatchView batchId="b1" />, fresh());
    await screen.findByText('USER-A');
    expect(screen.getByText(/may or may not have been invited/)).toBeTruthy();
    expect(within(rowOf('USER-A')).getByText('Outcome unknown')).toBeTruthy();
    fireEvent.click(within(rowOf('USER-A')).getByRole('button', { name: 'It was invited' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.url.pathname).toBe('/api/v1/invitation-batches/b1/items/a/resolve');
    expect(JSON.parse(String(posts()[0]?.init?.body))).toEqual({ outcome: 'invited' });
    fireEvent.click(within(rowOf('USER-A')).getByRole('button', { name: 'It was not invited' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(String(posts()[1]?.init?.body))).toEqual({ outcome: 'not_invited' });
  });

  it('[UI-029] shows the problem when the batch cannot be loaded', async () => {
    mockApi(() => json({ type: 'x', title: 'x', status: 404, code: 'not_found' }, 404));
    renderWithApp(<BatchView batchId="b1" />, fresh());
    expect(await screen.findByText('The item you asked for does not exist.')).toBeTruthy();
  });
});
