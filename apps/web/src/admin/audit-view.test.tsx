// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTORS } from '../test-admin.ts';
import { mockApi } from '../test-api.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { AUDIT_PAGE } from './api.ts';
import { AUDIT_DATA_PREVIEW, AuditLogView, auditBounds } from './audit-view.tsx';

// antd tables are slow to mount in jsdom, and the machine is shared: explicit, bounded timeouts.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

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

describe('[UI-035] audit log', () => {
  const EVENTS = [
    {
      id: 'e2',
      actorId: 'me',
      action: 'rpc.namingRule.update',
      subjectType: 'naming_rule',
      subjectId: 'rule-1',
      data: { pipeline: { from: 'a', to: 'b' } },
      at: '2026-10-08T10:00:00.000Z',
    },
    {
      id: 'e1',
      actorId: null,
      action: 'run.start',
      subjectType: 'run',
      subjectId: 'run-9',
      data: null,
      at: '2026-10-07T10:00:00.000Z',
    },
  ];

  it('[UI-035] lists events newest first, naming the Actor, and the system for events without one', async () => {
    mockApi(() => undefined, { actor: ACTORS, auditEvent: EVENTS });
    renderWithApp(<AuditLogView />, fresh());
    expect(await screen.findByText('rpc.namingRule.update')).toBeTruthy();
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('System')).toBeTruthy();
    expect(screen.getByText('run run-9')).toBeTruthy();
  });

  it('[UI-035] filters go to the server as a where clause, and the date range covers whole days', async () => {
    const { calls } = mockApi(() => undefined, { actor: ACTORS, auditEvent: [] });
    renderWithApp(<AuditLogView />, fresh());
    await screen.findByText('No audit events match.');
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'namingRule' } });
    fireEvent.change(screen.getByLabelText('Subject id'), { target: { value: 'rule-1' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-09' } });
    await waitFor(() => {
      const last = calls.filter((c) => c.url.pathname === '/api/model/auditEvent/findMany').at(-1);
      expect(JSON.parse(last?.url.searchParams.get('q') ?? '{}')).toMatchObject({
        where: {
          action: { contains: 'namingRule' },
          subjectId: 'rule-1',
          at: { gte: expect.any(String), lte: expect.any(String) },
        },
        take: AUDIT_PAGE,
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
      });
    });
  });

  it('[UI-035] a long change is cut short and expands on request', async () => {
    const long = { note: 'x'.repeat(AUDIT_DATA_PREVIEW * 3) };
    mockApi(() => undefined, {
      actor: ACTORS,
      auditEvent: [{ ...EVENTS[0], data: long }],
    });
    renderWithApp(<AuditLogView />, fresh());
    const more = await screen.findByRole('button', { name: 'Show all' });
    expect(screen.queryByText(new RegExp('x'.repeat(AUDIT_DATA_PREVIEW * 2)))).toBeNull();
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getByText(new RegExp('x'.repeat(AUDIT_DATA_PREVIEW * 2)))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('[UI-035] a full page offers the next one, on the last event id', async () => {
    const page = Array.from({ length: AUDIT_PAGE }, (_, i) => ({
      ...EVENTS[1],
      id: `e${i}`,
      action: `x.${i}`,
    }));
    const { calls } = mockApi(() => undefined, { actor: ACTORS, auditEvent: page });
    renderWithApp(<AuditLogView />, fresh());
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      const last = calls.filter((c) => c.url.pathname === '/api/model/auditEvent/findMany').at(-1);
      expect(JSON.parse(last?.url.searchParams.get('q') ?? '{}')).toMatchObject({
        cursor: { id: `e${AUDIT_PAGE - 1}` },
        skip: 1,
      });
    });
  });

  it('[UI-035] auditBounds turns dates into the start and end of their days, and leaves blanks out', () => {
    expect(auditBounds('', '')).toEqual({});
    const bounds = auditBounds('2026-10-01', '2026-10-09');
    expect(Date.parse(bounds.from ?? '')).toBeLessThan(Date.parse(bounds.to ?? ''));
    expect(auditBounds('not-a-date', '')).toEqual({});
  });
});
