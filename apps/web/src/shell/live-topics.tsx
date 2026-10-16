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
  // The registrations live in a ref so that the first connection can read the ones the page's
  // views made while mounting: their effects run before the provider's (children first).
  const registrationsRef = useRef<readonly Registration[]>([]);
  const [version, setVersion] = useState(0);
  const register = useCallback((registration: Registration) => {
    registrationsRef.current = [...registrationsRef.current, registration];
    setVersion((v) => v + 1);
    return () => {
      registrationsRef.current = registrationsRef.current.filter((r) => r !== registration);
      setVersion((v) => v + 1);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands for the ref's content
  const wanted = useMemo(() => topicsOf(registrationsRef.current), [version]);
  // No stream until the provider has mounted. The first connection then opens at once with the
  // topics of every view on the page, so a page load opens one stream, not one for the shell's
  // topics and another for the page's. Later changes of the topic set settle first, so a quick
  // navigation opens one stream and not one per step (ADR-0350).
  const [settled, setSettled] = useState<string | undefined>(undefined);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      setSettled(topicsOf(registrationsRef.current));
      return undefined;
    }
    const timer = setTimeout(() => setSettled(wanted), TOPIC_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [wanted]);
  const topics = useMemo(() => (settled === undefined ? [] : settled.split(',')), [settled]);
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

/** The sorted, de-duplicated topic list of the shell and the registered views, as one key. */
function topicsOf(registrations: readonly Registration[]): string {
  return [...new Set([...SHELL_TOPICS, ...registrations.flatMap((r) => r.topics)])]
    .sort()
    .join(',');
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
