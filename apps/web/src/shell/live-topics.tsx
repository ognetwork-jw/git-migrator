'use client';

import type { QueryKey } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type LiveMode, liveQueryKey, useLiveInvalidation } from '../live/index.ts';

/** What the shell keeps live for every page: the lists every page builds on (JOB-060). */
export const SHELL_TOPICS: readonly string[] = ['list:runs'];

/** Wait this long for the topic set to stop changing before connecting. */
const TOPIC_SETTLE_MS = 100;
/** Events within this window refetch a view once. */
const REFETCH_DEBOUNCE_MS = 300;

interface Registration {
  readonly topics: readonly string[];
  readonly queryKeysFor?: (topic: string) => readonly QueryKey[];
}

interface LiveTopicsValue {
  readonly mode: LiveMode;
  readonly register: (registration: Registration) => () => void;
}

const LiveTopicsContext = createContext<LiveTopicsValue | undefined>(undefined);

/**
 * The one live connection of a page (ADR-0350): the shell owns it, a page adds the topics it shows
 * with `useLiveTopics`. One Actor may hold 16 streams (ADR-0270), so a page must not open its own
 * and a table must never open one per row.
 */
export function LiveTopicsProvider({ children }: { readonly children: ReactNode }) {
  const [registrations, setRegistrations] = useState<readonly Registration[]>([]);
  const register = useCallback((registration: Registration) => {
    setRegistrations((current) => [...current, registration]);
    return () => setRegistrations((current) => current.filter((r) => r !== registration));
  }, []);
  const wanted = useMemo(
    () =>
      [...new Set([...SHELL_TOPICS, ...registrations.flatMap((r) => r.topics)])].sort().join(','),
    [registrations],
  );
  // The first connection opens at once; later changes of the topic set settle first, so a quick
  // navigation opens one stream and not one per step (ADR-0350).
  const [settled, setSettled] = useState(wanted);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(wanted), TOPIC_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [wanted]);
  const topics = useMemo(() => settled.split(','), [settled]);
  const registrationsRef = useRef(registrations);
  registrationsRef.current = registrations;
  const mode = useLiveInvalidation({
    topics,
    debounceMs: REFETCH_DEBOUNCE_MS,
    queryKeysFor: (topic) => [
      liveQueryKey(topic),
      ...registrationsRef.current.flatMap((r) => r.queryKeysFor?.(topic) ?? []),
    ],
  });
  const value = useMemo(() => ({ mode, register }), [mode, register]);
  return <LiveTopicsContext.Provider value={value}>{children}</LiveTopicsContext.Provider>;
}

/** The mode of the page's live connection, for the shell's status tag. */
export function useLiveMode(): LiveMode {
  return useContext(LiveTopicsContext)?.mode ?? 'connecting';
}

/**
 * Follow `topics` while the calling view is mounted. `queryKeysFor` names the TanStack Query keys
 * a topic refreshes (default: `['live', topic]`). Outside a shell it does nothing.
 */
export function useLiveTopics(
  topics: readonly string[],
  queryKeysFor?: (topic: string) => readonly QueryKey[],
): void {
  const context = useContext(LiveTopicsContext);
  const register = context?.register;
  const keysRef = useRef(queryKeysFor);
  keysRef.current = queryKeysFor;
  const topicsKey = [...new Set(topics)].sort().join(',');
  useEffect(() => {
    if (register === undefined) return undefined;
    return register({
      topics: topicsKey === '' ? [] : topicsKey.split(','),
      queryKeysFor: (topic) => keysRef.current?.(topic) ?? [],
    });
  }, [register, topicsKey]);
}
