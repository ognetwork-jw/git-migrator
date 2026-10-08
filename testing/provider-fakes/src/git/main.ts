import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_GIT_PORT, startFakeGitServer } from './server.ts';

/**
 * Standalone entry: `node src/git/main.ts`. Env: GM_FAKE_GIT_PORT (4030), GM_FAKE_GIT_ROOT
 * (a fresh temp dir), GM_FAKE_GIT_HOST (127.0.0.1), GM_FAKE_GIT_TOKEN (fake-token, both sides).
 */
const rootDir = process.env.GM_FAKE_GIT_ROOT ?? (await mkdtemp(join(tmpdir(), 'fake-git-')));
const token = process.env.GM_FAKE_GIT_TOKEN ?? 'fake-token';
const server = await startFakeGitServer({
  rootDir,
  port: Number(process.env.GM_FAKE_GIT_PORT ?? DEFAULT_GIT_PORT),
  host: process.env.GM_FAKE_GIT_HOST,
  source: { tokens: [token] },
  target: { tokens: [token] },
});
console.log(`fake git server listening on ${server.baseUrl} (root ${rootDir})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
