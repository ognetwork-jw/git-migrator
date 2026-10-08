// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { theme } from 'antd';
import { afterEach, describe, expect, it } from 'vitest';
import { installMatchMedia } from '../test-render.tsx';
import { AppProviders, themeFor } from './providers.tsx';
import { usePrefersDark } from './use-prefers-dark.ts';

afterEach(cleanup);

describe('themes', () => {
  it('[UI-001] the antd algorithm follows the OS color scheme', () => {
    expect(themeFor(false).algorithm).toBe(theme.defaultAlgorithm);
    expect(themeFor(true).algorithm).toBe(theme.darkAlgorithm);
  });

  it('[UI-001] usePrefersDark tracks changes of the OS preference', () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => usePrefersDark());
    expect(result.current).toBe(false);
    act(() => media.setDark(true));
    expect(result.current).toBe(true);
    act(() => media.setDark(false));
    expect(result.current).toBe(false);
  });

  it('[UI-001] without matchMedia the light theme is used', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const { result } = renderHook(() => usePrefersDark());
    expect(result.current).toBe(false);
  });

  it('[UI-001] AppProviders renders its children with the antd context', () => {
    installMatchMedia(true);
    render(
      <AppProviders>
        <p>inside</p>
      </AppProviders>,
    );
    expect(screen.getByText('inside')).toBeTruthy();
  });
});
