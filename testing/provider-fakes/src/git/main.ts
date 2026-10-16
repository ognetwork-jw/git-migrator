import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GIT_PORT, startFakeGitServer } from './server.ts';

/**
 * Standalone entry: `node src/git/main.ts`. Env (same names as `src/main.ts`): FAKE_GIT_PORT (4030),
 * FAKE_GIT_ROOT (a fresh temp dir), FAKES_HOST (127.0.0.1), FAKE_GIT_PUBLIC_URL (the listening
 * address), FAKE_GIT_TOKEN (fake-token, both sides).
 */
const rootDir = process.env.FAKE_GIT_ROOT ?? (await mkdtemp(join(tmpdir(), 'fake-git-')));
const token = process.env.FAKE_GIT_TOKEN ?? 'fake-token';
const server = await startFakeGitServer({
  rootDir,
  port: Number(process.env.FAKE_GIT_PORT ?? DEFAULT_GIT_PORT),
  host: process.env.FAKES_HOST,
  publicUrl: process.env.FAKE_GIT_PUBLIC_URL,
  source: { tokens: [token] },
  target: { tokens: [token] },
});
console.log(`fake git server listening on ${server.baseUrl} (root ${rootDir})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
