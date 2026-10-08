import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const snapshot = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(QUERY).matches;

/**
 * True when the OS asks for the dark theme (UI-001). The server and the first client render use the
 * light theme, so hydration matches; the dark theme applies right after.
 */
export function usePrefersDark(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
