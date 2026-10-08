import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { DEFAULT_HOST, startWebPlaceholder } from './dev-server.ts';

describe('web placeholder dev server', () => {
  it('[DEV-040] binds loopback by default; the dev image sets HOST=0.0.0.0 for Compose', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  it('[DEV-040] binds the default host: the bound address is 127.0.0.1', async () => {
    const server = await startWebPlaceholder({ port: 0, host: DEFAULT_HOST });
    try {
      const address = server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('[DEV-040] serves the placeholder text on the requested port', async () => {
    const server = await startWebPlaceholder({ port: 0, host: '127.0.0.1' });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('placeholder');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
