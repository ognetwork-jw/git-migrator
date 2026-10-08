import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBareRepo, sha256 } from './seed.ts';
import { type FakeGitServer, startFakeGitServer } from './server.ts';

vi.setConfig({ testTimeout: 30_000 });

const TOKEN = 'ticket-test-token';
const auth = { authorization: `Basic ${Buffer.from(`u:${TOKEN}`).toString('base64')}` };

let work: string;
let server: FakeGitServer;
let allowed = true;
const seen: { username: string; operation: string }[] = [];

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'fake-lfs-ticket-'));
  server = await startFakeGitServer({
    rootDir: join(work, 'root'),
    port: 0,
    lfsTicketTtlMs: 400,
    target: {
      tokens: [TOKEN],
      authorize: ({ username, operation }) => {
        seen.push({ username, operation });
        return allowed ? undefined : 403;
      },
    },
  });
  await createBareRepo(server.repoDir('target', 'acme/t'));
  await createBareRepo(server.repoDir('target', 'acme/other'));
});

afterAll(async () => {
  await server.close();
  await rm(work, { recursive: true, force: true });
});

async function batch(operation: 'download' | 'upload', content: string, repo = 'acme/t') {
  const oid = sha256(content);
  const res = await fetch(`${server.repoUrl('target', repo)}/info/lfs/objects/batch`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/vnd.git-lfs+json' },
    body: JSON.stringify({ operation, objects: [{ oid, size: content.length }] }),
  });
  const body = (await res.json()) as {
    objects: { actions?: Record<string, { href: string; header: Record<string, string> }> }[];
  };
  return { oid, actions: body.objects[0]?.actions ?? {} };
}

describe('LFS action tickets', () => {
  it('[TST-013] an upload ticket PUTs and verifies, and is refused for download and for another repository', async () => {
    allowed = true;
    const { oid, actions } = await batch('upload', 'ticket-one');
    const upload = actions.upload as { href: string; header: Record<string, string> };
    const verify = actions.verify as { href: string; header: Record<string, string> };
    expect(Object.keys(upload.header)).toEqual(['X-Fake-Lfs-Ticket']);
    expect(JSON.stringify(actions)).not.toContain(TOKEN);
    expect((await fetch(upload.href, { method: 'GET', headers: upload.header })).status).toBe(401);
    const put = await fetch(upload.href, {
      method: 'PUT',
      headers: upload.header,
      body: 'ticket-one',
    });
    expect(put.status).toBe(200);
    const verified = await fetch(verify.href, {
      method: 'POST',
      headers: { ...verify.header, 'content-type': 'application/json' },
      body: JSON.stringify({ oid, size: 10 }),
    });
    expect(verified.status).toBe(200);
    const elsewhere = upload.href.replace('acme/t.git', 'acme/other.git');
    expect(
      (await fetch(elsewhere, { method: 'PUT', headers: upload.header, body: 'x' })).status,
    ).toBe(401);
  });

  it('[TST-013] a download ticket cannot PUT or verify', async () => {
    allowed = true;
    await batch('upload', 'ticket-two').then(async ({ actions }) => {
      const up = actions.upload as { href: string; header: Record<string, string> };
      await fetch(up.href, { method: 'PUT', headers: up.header, body: 'ticket-two' });
    });
    const { oid, actions } = await batch('download', 'ticket-two');
    const download = actions.download as { href: string; header: Record<string, string> };
    expect((await fetch(download.href, { headers: download.header })).status).toBe(200);
    expect(
      (await fetch(download.href, { method: 'PUT', headers: download.header, body: 'zzz' })).status,
    ).toBe(401);
    const verify = await fetch(`${server.repoUrl('target', 'acme/t')}/info/lfs/verify`, {
      method: 'POST',
      headers: { ...download.header, 'content-type': 'application/json' },
      body: JSON.stringify({ oid, size: 10 }),
    });
    expect(verify.status).toBe(401);
  });

  it('[TST-013] authorize runs on ticketed requests for the identity that called the batch endpoint, and revoking it stops the ticket', async () => {
    allowed = true;
    const { actions } = await batch('upload', 'ticket-three');
    const upload = actions.upload as { href: string; header: Record<string, string> };
    seen.length = 0;
    expect(
      (await fetch(upload.href, { method: 'PUT', headers: upload.header, body: 'ticket-three' }))
        .status,
    ).toBe(200);
    expect(seen).toEqual([{ username: 'u', operation: 'write' }]);
    allowed = false;
    expect(
      (await fetch(upload.href, { method: 'PUT', headers: upload.header, body: 'ticket-three' }))
        .status,
    ).toBe(403);
    allowed = true;
  });

  it('[TST-013] a ticket expires', async () => {
    allowed = true;
    const { actions } = await batch('upload', 'ticket-four');
    const upload = actions.upload as { href: string; header: Record<string, string> };
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      (await fetch(upload.href, { method: 'PUT', headers: upload.header, body: 'ticket-four' }))
        .status,
    ).toBe(401);
  });
});
