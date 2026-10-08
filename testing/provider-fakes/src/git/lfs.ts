import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const OID = /^[0-9a-f]{64}$/;
export const LFS_TICKET_HEADER = 'X-Fake-Lfs-Ticket';
export const LFS_CONTENT_TYPE = 'application/vnd.git-lfs+json';

/** On-disk store of LFS objects for one side, keyed by repository and sha256 (TST-013). */
export class LfsObjectStore {
  readonly dir: string;
  /** Sizes announced by upload batches, keyed `repo:oid`; a PUT must match them (422 otherwise). */
  readonly expected = new Map<string, number>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Path of an object; `repo` is the repository path without `.git`. */
  objectPath(repo: string, oid: string): string {
    return join(this.dir, repo, oid.slice(0, 2), oid.slice(2, 4), oid);
  }

  async size(repo: string, oid: string): Promise<number | undefined> {
    try {
      return (await stat(this.objectPath(repo, oid))).size;
    } catch {
      return undefined;
    }
  }

  async put(repo: string, content: Buffer | string): Promise<{ oid: string; size: number }> {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    const oid = createHash('sha256').update(buf).digest('hex');
    const path = this.objectPath(repo, oid);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, path);
    return { oid, size: buf.length };
  }

  async get(repo: string, oid: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.objectPath(repo, oid));
    } catch {
      return undefined;
    }
  }

  /** Streams a request body to disk, verifying sha256 and size. Returns an error message on mismatch. */
  async receive(
    repo: string,
    oid: string,
    size: number | undefined,
    body: NodeJS.ReadableStream,
  ): Promise<string | undefined> {
    const path = this.objectPath(repo, oid);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    const hash = createHash('sha256');
    let bytes = 0;
    body.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    try {
      await pipeline(body, createWriteStream(tmp));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    if (hash.digest('hex') !== oid || (size !== undefined && bytes !== size)) {
      await rm(tmp, { force: true });
      return 'Content does not match the object id or size';
    }
    await rename(tmp, path);
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': LFS_CONTENT_TYPE,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export interface LfsRequestContext {
  store: LfsObjectStore;
  /** Repository path without `.git`. */
  repo: string;
  /** Absolute URL of the LFS endpoint for this repository, no trailing slash. */
  lfsUrl: string;
  /** Rest of the path after `/info/lfs`, e.g. `/objects/batch`. */
  subPath: string;
  maxBatchObjects: number;
  /** Issues the ticket that the actions of one operation require (see the server). */
  issueTicket(operation: 'download' | 'upload'): string;
}

/** Minimal Git LFS server, basic transfer only: batch, object PUT/GET and verify (TST-013). */
export async function handleLfs(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: LfsRequestContext,
): Promise<void> {
  const { store, repo, subPath } = ctx;
  const method = req.method ?? 'GET';
  try {
    if (method === 'POST' && subPath === '/objects/batch') return await batch(req, res, ctx);
    if (method === 'POST' && subPath === '/verify') {
      const body = (await readJson(req)) as { oid?: string; size?: number };
      const size = body.oid && OID.test(body.oid) ? await store.size(repo, body.oid) : undefined;
      if (size === undefined || size !== body.size) {
        return json(res, 404, { message: 'Object does not exist' });
      }
      return json(res, 200, {});
    }
    const m = /^\/objects\/([^/]+)$/.exec(subPath);
    const oid = m?.[1];
    if (oid && OID.test(oid) && method === 'PUT') {
      const declared = req.headers['content-length'];
      const err = await store.receive(
        repo,
        oid,
        store.expected.get(`${repo}:${oid}`) ??
          (declared === undefined ? undefined : Number(declared)),
        req,
      );
      if (err) return json(res, 422, { message: err });
      res.writeHead(200, { 'content-length': 0 });
      return void res.end();
    }
    if (oid && OID.test(oid) && (method === 'GET' || method === 'HEAD')) {
      const size = await store.size(repo, oid);
      if (size === undefined) return json(res, 404, { message: 'Object does not exist' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
      if (method === 'HEAD') return void res.end();
      return await pipeline(createReadStream(store.objectPath(repo, oid)), res);
    }
    return json(res, 404, { message: 'Not found' });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { message: (error as Error).message });
    else res.destroy();
  }
}

async function batch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: LfsRequestContext,
): Promise<void> {
  const body = (await readJson(req)) as {
    operation?: string;
    transfers?: string[];
    objects?: { oid: string; size: number }[];
  };
  if (body.operation !== 'download' && body.operation !== 'upload') {
    return json(res, 422, { message: 'Invalid operation' });
  }
  if (body.transfers && !body.transfers.includes('basic')) {
    return json(res, 422, { message: 'Only the basic transfer is supported' });
  }
  const objects = body.objects ?? [];
  if (objects.length > ctx.maxBatchObjects) {
    return json(res, 413, { message: `Too many objects in batch (max ${ctx.maxBatchObjects})` });
  }
  // `authenticated: true` tells the client not to look up credentials for the actions, so each
  // action carries the header its endpoint requires (git-lfs batch API: actions[].header). The
  // header is a ticket for this repository and operation, never the caller's credential.
  const headerFor = (operation: 'download' | 'upload'): Record<string, string> => ({
    [LFS_TICKET_HEADER]: ctx.issueTicket(operation),
  });
  const out = [];
  for (const { oid, size } of objects) {
    if (!OID.test(oid ?? '') || !Number.isInteger(size) || size < 0) {
      out.push({ oid, size, error: { code: 422, message: 'Invalid object id or size' } });
      continue;
    }
    const existing = await ctx.store.size(ctx.repo, oid);
    const href = `${ctx.lfsUrl}/objects/${oid}`;
    if (body.operation === 'download') {
      out.push(
        existing === undefined
          ? { oid, size, error: { code: 404, message: 'Object does not exist' } }
          : {
              oid,
              size: existing,
              authenticated: true,
              actions: { download: { href, header: headerFor('download') } },
            },
      );
    } else if (existing === size) {
      out.push({ oid, size }); // already stored: no actions
    } else {
      ctx.store.expected.set(`${ctx.repo}:${oid}`, size);
      out.push({
        oid,
        size,
        authenticated: true,
        actions: (() => {
          const header = headerFor('upload');
          return { upload: { href, header }, verify: { href: `${ctx.lfsUrl}/verify`, header } };
        })(),
      });
    }
  }
  json(res, 200, { transfer: 'basic', objects: out, hash_algo: 'sha256' });
}
