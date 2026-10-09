// @vitest-environment jsdom
import { QueryClient, useQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithApp } from '../test-render.tsx';
import { LiveTopicsProvider, useLiveMode, useLiveTopics } from './live-topics.tsx';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: { data?: string }) => void>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  emit(topics: string[]) {
    this.listeners.get('gm')?.({ data: JSON.stringify({ topics }) });
  }
}

const open = () => FakeEventSource.instances.filter((s) => !s.closed);

function Page({ fetcher }: { readonly fetcher: () => Promise<string> }) {
  useLiveTopics(['list:migrations', 'quota'], (topic) => [[topic === 'quota' ? 'q' : 'm']]);
  const result = useQuery({ queryKey: ['m'], queryFn: fetcher });
  return <p>{result.data ?? 'loading'}</p>;
}

function Mode() {
  return <span data-testid="mode">{useLiveMode()}</span>;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('[JOB-060] one live connection per page', () => {
  it('[JOB-060] a page adds its topics to the shell connection instead of opening its own', async () => {
    renderWithApp(
      <LiveTopicsProvider>
        <Mode />
        <Page fetcher={async () => 'x'} />
      </LiveTopicsProvider>,
    );
    await waitFor(() => {
      expect(open()).toHaveLength(1);
      expect(open()[0]?.url).toContain('topics=list%3Amigrations,list%3Aruns,quota');
    });
  });

  it('[JOB-060] an event on a page topic refetches the page queries', async () => {
    let calls = 0;
    const fetcher = async () => `call ${++calls}`;
    renderWithApp(
      <LiveTopicsProvider>
        <Page fetcher={fetcher} />
      </LiveTopicsProvider>,
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    await screen.findByText('call 1');
    await waitFor(() => expect(open()[0]?.url).toContain('list%3Amigrations'));
    expect(open()).toHaveLength(1);
    const source = open()[0] as FakeEventSource;
    await act(async () => {
      source.onopen?.();
      source.emit(['list:migrations']);
    });
    await screen.findByText('call 2', {}, { timeout: 3000 });
  });

  it('[JOB-060] leaving the page drops its topics and keeps a single stream', async () => {
    function Toggle() {
      const [shown, setShown] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShown(false)}>
            leave
          </button>
          {shown ? <Page fetcher={async () => 'x'} /> : null}
        </>
      );
    }
    renderWithApp(
      <LiveTopicsProvider>
        <Toggle />
      </LiveTopicsProvider>,
    );
    await waitFor(() => expect(open()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'leave' }));
    await waitFor(() => {
      expect(open()).toHaveLength(1);
      expect(open()[0]?.url).toBe('/api/v1/events?topics=list%3Aruns');
    });
  });

  it('[JOB-060] rapid mounts and unmounts open at most one stream', async () => {
    function Flicker() {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setN((v) => v + 1)}>
            flip
          </button>
          {n % 2 === 0 ? <Page fetcher={async () => 'x'} /> : null}
        </>
      );
    }
    renderWithApp(
      <LiveTopicsProvider>
        <Flicker />
      </LiveTopicsProvider>,
    );
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'flip' }));
    await waitFor(() => expect(open()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The first stream opens at once; the flicker adds at most one more, never two at a time.
    expect(open()).toHaveLength(1);
    expect(FakeEventSource.instances.length).toBeLessThanOrEqual(2);
  });

  it('[JOB-060] a burst of events refetches a view once', async () => {
    let calls = 0;
    renderWithApp(
      <LiveTopicsProvider>
        <Page fetcher={async () => `call ${++calls}`} />
      </LiveTopicsProvider>,
    );
    await screen.findByText('call 1');
    await waitFor(() => expect(open()[0]?.url).toContain('list%3Amigrations'));
    expect(open()).toHaveLength(1);
    const source = open()[0] as FakeEventSource;
    await act(async () => {
      source.onopen?.();
      for (let i = 0; i < 5; i++) source.emit(['list:migrations']);
    });
    await screen.findByText('call 2', {}, { timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls).toBe(2);
  });

  it('[JOB-060] outside a shell the hooks do nothing', () => {
    renderWithApp(
      <>
        <Mode />
        <Page fetcher={async () => 'x'} />
      </>,
    );
    expect(screen.getByTestId('mode').textContent).toBe('connecting');
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
