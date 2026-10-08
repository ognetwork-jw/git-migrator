// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../api/actor.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { ActorProvider, useActor } from './actor-context.tsx';
import { DeniedView } from './denied-view.tsx';

const VIEWER: Actor = {
  id: 'a1',
  displayName: 'Vera Viewer',
  email: null,
  role: 'viewer',
  disabled: false,
};

beforeEach(() => {
  installMatchMedia(false);
});
afterEach(cleanup);

describe('DeniedView', () => {
  it('[UI-036] explains the role the page needs and the one the Actor has', () => {
    renderWithApp(
      <ActorProvider value={VIEWER}>
        <DeniedView required="admin" />
      </ActorProvider>,
    );
    expect(screen.getByText('Your role does not allow this page')).toBeTruthy();
    expect(
      screen.getByText(
        'This page needs the Admin role. You are signed in as Vera Viewer with the Viewer role. Ask an administrator if you need access.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' }).getAttribute('href')).toBe(
      '/',
    );
  });

  it('[UI-036] ignores a required role it does not know', () => {
    renderWithApp(
      <ActorProvider value={VIEWER}>
        <DeniedView required="<b>root</b>" />
      </ActorProvider>,
    );
    expect(screen.getByText(/needs a higher role than yours/)).toBeTruthy();
  });
});

describe('useActor', () => {
  it('[UI-010] refuses to run outside the shell', () => {
    function Probe() {
      useActor();
      return null;
    }
    expect(() => renderWithApp(<Probe />)).toThrow(/inside the app shell/);
  });
});
