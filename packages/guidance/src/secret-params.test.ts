import { describe, expect, it } from 'vitest';
import { renderGuidance } from './render.ts';
import { joinSecretParams, splitSecretParams } from './secret-params.ts';

const URL = 'https://ci.example.test/hooks/1?token=abc';

describe('secret guidance parameters (FAC-WEB-002, ADR-0503)', () => {
  it('[FAC-WEB-002] targetUrl is split off, and its display form stays with the other parameters', () => {
    expect(splitSecretParams({ key: 'k', targetUrl: URL, events: ['push'] })).toEqual({
      params: { key: 'k', targetUrlDisplay: 'https://ci.example.test/…', events: ['push'] },
      secretParams: { targetUrl: URL },
    });
    expect(splitSecretParams({ repository: 'acme/r' })).toEqual({
      params: { repository: 'acme/r' },
      secretParams: null,
    });
  });

  it('[FAC-WEB-002] without the secret part the guidance names the display form and offers no copy snippet', () => {
    const { params, secretParams } = splitSecretParams({
      key: 'k',
      targetUrl: URL,
      events: ['push'],
    });
    const viewer = renderGuidance('webhooks.recreate-manually', joinSecretParams(params, null));
    expect(JSON.stringify(viewer)).not.toContain('token=abc');
    expect(viewer.summary).toContain('ci.example.test/…');
    expect(viewer.steps.some((s) => s.copy !== undefined)).toBe(false);
    const operator = renderGuidance(
      'webhooks.recreate-manually',
      joinSecretParams(params, secretParams),
    );
    expect(operator.steps.some((s) => s.copy?.includes(URL))).toBe(true);
  });
});
