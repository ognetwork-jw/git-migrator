import { useEffect, useSyncExternalStore } from 'react';
import { colorSchemeCookie } from './color-scheme.ts';

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
 * True when the OS asks for the dark theme (UI-001). The server render and hydration use
 * `initialDark`, the scheme the browser reported on its last visit (a cookie, ADR-0520), so a
 * returning visitor's first paint is already dark; the OS preference applies right after and is
 * remembered for the next visit.
 */
export function usePrefersDark(initialDark = false): boolean {
  const dark = useSyncExternalStore(subscribe, snapshot, () => initialDark);
  useEffect(() => {
    try {
      // biome-ignore lint/suspicious/noDocumentCookie: a display preference read by the server render
      document.cookie = colorSchemeCookie(dark);
    } catch {
      // Cookies may be blocked; the first paint is then light, as before.
    }
  }, [dark]);
  return dark;
}
