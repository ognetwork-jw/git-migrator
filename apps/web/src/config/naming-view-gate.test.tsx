// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query';
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callsTo, json, problem } from '../test-api.ts';
import { COLLISION, preview, setupNaming } from '../test-naming.ts';
import { installMatchMedia, renderWithApp } from '../test-render.tsx';
import { NamingRulesView } from './naming-view.tsx';

// antd modals are slow to mount in jsdom, and the machine is shared: explicit, bounded timeouts.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

const fresh = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function openEditor() {
  await screen.findByText('Projects');
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  return within(await screen.findByRole('dialog'));
}

beforeEach(() => {
  installMatchMedia(false);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('[UI-030] naming rules save gate', () => {
  it('[UI-030] the save waits for a preview, and an edit afterwards makes the preview stale', async () => {
    const { calls } = setupNaming(() => json(preview()));
    renderWithApp(<NamingRulesView />, fresh());
    const dialog = await openEditor();
    const save = dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(dialog.getByText('Preview the names before saving.')).toBeTruthy();
    // The example braces are data, not ICU placeholders: the editor must render (UI-030).
    expect(
      dialog.getByText(
        'Name the result with the variables the steps set, for example {namespace}-{repository}.',
      ),
    ).toBeTruthy();

    fireEvent.click(dialog.getByRole('button', { name: 'Preview names' }));
    await dialog.findByText('2 affected, 2 renamed, 0 invalid, 0 colliding.');
    expect(save.disabled).toBe(false);

    fireEvent.change(dialog.getByLabelText('Template'), { target: { value: '{repository}' } });
    expect(
      dialog.getByText('The rule changed since the last preview. Preview again before saving.'),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(callsTo(calls, 'PUT', '/api/model/namingRule/update')).toHaveLength(0);
  });

  it('[UI-030] collisions need a confirmation, and an edit followed by a revert asks again', async () => {
    const { calls } = setupNaming(() => json(preview(COLLISION)));
    renderWithApp(<NamingRulesView />, fresh());
    const dialog = await openEditor();
    const acceptance = { name: 'Save anyway. I accept that these repositories collide.' };

    fireEvent.click(dialog.getByRole('button', { name: 'Preview names' }));
    const confirm = (await dialog.findByRole('checkbox', acceptance)) as HTMLInputElement;
    const save = dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(dialog.getByText('Confirm the collisions to save this rule.')).toBeTruthy();

    fireEvent.click(confirm);
    expect(save.disabled).toBe(false);

    // Edit away and revert: the old preview fits the rule again, but the acceptance is gone.
    const template = dialog.getByLabelText('Template') as HTMLInputElement;
    const original = template.value;
    fireEvent.change(template, { target: { value: '{repository}' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(template, { target: { value: original } });
    await waitFor(() => {
      const box = dialog.queryByRole('checkbox', acceptance) as HTMLInputElement | null;
      expect(box?.checked ?? false).toBe(false);
    });
    expect(save.disabled).toBe(true);
    expect(callsTo(calls, 'PUT', '/api/model/namingRule/update')).toHaveLength(0);

    // Preview the reverted rule again, confirm, and the save goes through.
    fireEvent.click(dialog.getByRole('button', { name: 'Preview names' }));
    fireEvent.click(await dialog.findByRole('checkbox', acceptance));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(callsTo(calls, 'PUT', '/api/model/namingRule/update')).toHaveLength(1),
    );
  });

  it('[UI-030] a preview the API refuses blocks the save and says why', async () => {
    setupNaming(() => problem(422, 'validation_failed'));
    renderWithApp(<NamingRulesView />, fresh());
    const dialog = await openEditor();
    fireEvent.click(dialog.getByRole('button', { name: 'Preview names' }));
    expect(
      await dialog.findByText(
        'The preview could not run: Some of the values you entered are not valid.',
      ),
    ).toBeTruthy();
    expect(
      dialog.getByText(
        'The preview could not run, so collisions cannot be checked. Narrow the rule or try again later.',
      ),
    ).toBeTruthy();
    expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
