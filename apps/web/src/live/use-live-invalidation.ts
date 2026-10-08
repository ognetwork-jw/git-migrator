import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createLiveConnection, type EventSourceLike, type LiveMode } from './live-connection.ts';

/** The query key a view adds to its queries to follow `topic` (JOB-060). */
export const liveQueryKey = (topic: string): QueryKey => ['live', topic];

export interface UseLiveInvalidationOptions {
  /** The topics the view shows, for example `['migration:abc', 'list:runs']`. */
  readonly topics: readonly string[];
  /** The query keys to invalidate for a topic. Default: `[liveQueryKey(topic)]`. */
  readonly queryKeysFor?: (topic: string) => readonly QueryKey[];
  readonly path?: string;
  /** For tests. */
  readonly createEventSource?: (url: string) => EventSourceLike | undefined;
  readonly staleAfterMs?: number;
  readonly pollEveryMs?: number;
}

const defaultKeysFor = (topic: string): readonly QueryKey[] => [liveQueryKey(topic)];

/**
 * Keeps a view live (JOB-060): subscribes to `topics` over SSE and invalidates the matching
 * TanStack Query keys when something changes, so the queries refetch through ZenStack or the API
 * and permissions are enforced there. Falls back to polling when SSE is unavailable or silent,
 * and returns the current mode so the shell can show it.
 */
export function useLiveInvalidation(options: UseLiveInvalidationOptions): LiveMode {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<LiveMode>('connecting');
  const latest = useRef(options);
  latest.current = options;
  const topicsKey = [...new Set(options.topics)].sort().join(',');

  useEffect(() => {
    const topics = topicsKey === '' ? [] : topicsKey.split(',');
    if (topics.length === 0) return undefined;
    const connection = createLiveConnection({
      topics,
      path: latest.current.path,
      createEventSource: latest.current.createEventSource,
      staleAfterMs: latest.current.staleAfterMs,
      pollEveryMs: latest.current.pollEveryMs,
      onModeChange: setMode,
      onInvalidate: (changed) => {
        const keysFor = latest.current.queryKeysFor ?? defaultKeysFor;
        for (const topic of changed) {
          for (const queryKey of keysFor(topic)) {
            void queryClient.invalidateQueries({ queryKey });
          }
        }
      },
    });
    connection.start();
    return () => connection.stop();
  }, [topicsKey, queryClient]);

  return mode;
}
