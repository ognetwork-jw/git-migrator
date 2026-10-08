// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { EventSourceLike } from './live-connection.ts';
import { liveQueryKey, useLiveInvalidation } from './use-live-invalidation.ts';

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: { data?: string }) => void>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
}

const last = () => FakeEventSource.instances.at(-1) as FakeEventSource;
const create = (url: string) => new FakeEventSource(url);

describe('useLiveInvalidation (JOB-060)', () => {
  let client: QueryClient;
  let invalidate: MockInstance<QueryClient['invalidateQueries']>;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    client = new QueryClient();
    invalidate = vi.spyOn(client, 'invalidateQueries');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('[JOB-060] invalidates the query keys of the topics an event names', () => {
    const { result } = renderHook(
      () => useLiveInvalidation({ topics: ['run:r1', 'list:runs'], createEventSource: create }),
      { wrapper },
    );
    expect(result.current).toBe('connecting');
    act(() => last().onopen?.({}));
    expect(result.current).toBe('sse');
    act(() => last().listeners.get('gm')?.({ data: JSON.stringify({ topics: ['run:r1'] }) }));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: liveQueryKey('run:r1') });
  });

  it('[JOB-060] maps topics to the keys the view chooses', () => {
    renderHook(
      () =>
        useLiveInvalidation({
          topics: ['list:runs'],
          createEventSource: create,
          queryKeysFor: (topic) => [
            ['runs', 'list'],
            ['dashboard', topic],
          ],
        }),
      { wrapper },
    );
    act(() => last().onopen?.({}));
    act(() => last().listeners.get('resync')?.({}));
    expect(invalidate.mock.calls.map((c) => c[0])).toEqual([
      { queryKey: ['runs', 'list'] },
      { queryKey: ['dashboard', 'list:runs'] },
    ]);
  });

  it('[JOB-060] falls back to polling when SSE fails, invalidating every 10 seconds', () => {
    const { result } = renderHook(
      () => useLiveInvalidation({ topics: ['quota'], createEventSource: create }),
      { wrapper },
    );
    act(() => last().onopen?.({}));
    // The server goes silent: no event and no heartbeat.
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(result.current).toBe('polling');
    expect(invalidate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: liveQueryKey('quota') });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
    // A later reconnect succeeds: back to SSE.
    act(() => last().onopen?.({}));
    expect(result.current).toBe('sse');
  });

  it('[JOB-060] polls when EventSource is unavailable', () => {
    const { result } = renderHook(
      () => useLiveInvalidation({ topics: ['quota'], createEventSource: () => undefined }),
      { wrapper },
    );
    expect(result.current).toBe('polling');
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('[JOB-060] reconnects only when the topics change, and closes on unmount', () => {
    const { rerender, unmount } = renderHook(
      ({ topics }: { topics: string[] }) =>
        useLiveInvalidation({ topics, createEventSource: create, queryKeysFor: () => [] }),
      { wrapper, initialProps: { topics: ['run:a', 'quota'] } },
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    rerender({ topics: ['quota', 'run:a'] }); // same set, new array
    expect(FakeEventSource.instances).toHaveLength(1);
    rerender({ topics: ['run:b'] });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    unmount();
    expect(last().closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('[JOB-060] opens no connection without topics', () => {
    renderHook(() => useLiveInvalidation({ topics: [], createEventSource: create }), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
