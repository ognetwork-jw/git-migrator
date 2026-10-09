// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { GuidanceView, guidanceParams } from './guidance-view.tsx';
import { tokenizeInline, unescapeMarkdown } from './inline-markdown.tsx';

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubClipboard(write: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(write) },
  });
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
}

describe('[UI-040] guidance parameters', () => {
  it('[UI-040] keeps only parameter names the guidance knows and lets the finding override defaults', () => {
    const merged = guidanceParams(
      { names: ['A'], notAParam: 'x', repository: 'from/finding' },
      { defaults: { repository: 'from/default', scope: 'repository' } },
    );
    expect(merged).toEqual({ names: ['A'], repository: 'from/finding', scope: 'repository' });
  });

  it('[UI-040] a null value does not hide a default, and field paths stand in for missing paths', () => {
    expect(
      guidanceParams(
        { repository: null },
        { defaults: { repository: 'acme/x' }, fieldPaths: ['/a'] },
      ),
    ).toEqual({ repository: 'acme/x', paths: ['/a'] });
    expect(guidanceParams({ paths: ['/b'] }, { fieldPaths: ['/a'] })).toEqual({ paths: ['/b'] });
  });

  it('[UI-040] params that are not an object are ignored', () => {
    expect(guidanceParams('nope', { defaults: { repository: 'acme/x' } })).toEqual({
      repository: 'acme/x',
    });
    expect(guidanceParams(['x'])).toEqual({});
  });
});

describe('[UI-040] inline markdown', () => {
  it('[UI-040] resolves escapes and the references that keep a URL from becoming a link', () => {
    expect(unescapeMarkdown('a\\_b\\*c https&#58;//x&#46;test')).toBe('a_b*c https://x.test');
  });

  it('[UI-040] splits code spans from text and leaves an unterminated backtick as text', () => {
    expect(tokenizeInline('Add `a\\_b` now')).toEqual([
      { kind: 'text', text: 'Add ' },
      { kind: 'code', text: 'a_b' },
      { kind: 'text', text: ' now' },
    ]);
    expect(tokenizeInline('open `tick')).toEqual([{ kind: 'text', text: 'open `tick' }]);
    expect(tokenizeInline('esc \\` not code `x`')).toEqual([
      { kind: 'text', text: 'esc ` not code ' },
      { kind: 'code', text: 'x' },
    ]);
  });
});

describe('[UI-040] the guidance view', () => {
  const secrets = {
    code: 'secrets.set-value',
    params: { names: ['API_TOKEN', 'DB_PASSWORD'], scope: 'repository' },
    defaults: { repository: 'acme/payments' },
  } as const;

  it('[UI-040] shows title, summary, severity and a copy button with the command of each step', async () => {
    installMatchMedia();
    renderWithApp(<GuidanceView {...secrets} />);
    expect(screen.getByText('Set secret values')).toBeTruthy();
    expect(screen.getByText(/must be set by hand in repository on acme\/payments/)).toBeTruthy();
    expect(screen.getByText('After the run')).toBeTruthy();
    expect(screen.getByText('Checked by parity')).toBeTruthy();
    const command = document.querySelector('pre');
    expect(command?.textContent).toBe(
      'gh secret set API_TOKEN --repo acme/payments\ngh secret set DB_PASSWORD --repo acme/payments',
    );
    expect(screen.getAllByRole('button', { name: /^Copy / })).toHaveLength(1);
  });

  it('[UI-040] the copy button writes exactly the command to the clipboard and says so', async () => {
    installMatchMedia();
    const write = stubClipboard(async () => undefined);
    renderWithApp(<GuidanceView {...secrets} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Copy / }));
    });
    expect(write).toHaveBeenCalledWith(
      'gh secret set API_TOKEN --repo acme/payments\ngh secret set DB_PASSWORD --repo acme/payments',
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'));
  });

  it('[UI-040] a refused clipboard write says so instead of claiming success', async () => {
    installMatchMedia();
    stubClipboard(async () => {
      throw new Error('denied');
    });
    renderWithApp(<GuidanceView {...secrets} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Copy / }));
    });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Copy failed/));
  });

  it('[UI-040] a missing value shows as a placeholder, drops the command and says the guidance is incomplete', () => {
    installMatchMedia();
    renderWithApp(<GuidanceView code="secrets.set-value" params={{ names: ['API_TOKEN'] }} />);
    expect(document.querySelector('pre')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Copy / })).toBeNull();
    expect(screen.getByText(/‹repository›/)).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/not known yet/);
  });

  it('[UI-040] a value from the source system is shown as text, never as markup', () => {
    installMatchMedia();
    renderWithApp(
      <GuidanceView
        code="secrets.set-value"
        params={{ names: ['<img src=x onerror=alert(1)>'], scope: 'repository' }}
        defaults={{ repository: 'acme/payments' }}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('[UI-040] a code without guidance is reported instead of throwing', () => {
    installMatchMedia();
    renderWithApp(<GuidanceView code="nope.not-a-code" />);
    expect(screen.getByText('There is no guidance for the finding nope.not-a-code.')).toBeTruthy();
  });

  it('[UI-040] the title can be left out when the caller shows the finding itself', () => {
    installMatchMedia();
    renderWithApp(<GuidanceView {...secrets} showTitle={false} />);
    expect(screen.queryByText('Set secret values')).toBeNull();
    expect(screen.getByText(/must be set by hand/)).toBeTruthy();
  });
});
