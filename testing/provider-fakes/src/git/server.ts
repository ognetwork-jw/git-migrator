import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { POLICY_FLAG_FILE, PRE_RECEIVE_HOOK } from './hook.ts';
import { handleLfs, LFS_TICKET_HEADER, LfsObjectStore } from './lfs.ts';
import { assertGitPrerequisites } from './preconditions.ts';

/** The two fake sides (TST-013): the migration source and the migration target. */
export type GitSide = 'source' | 'target';
export const GIT_SIDES: readonly GitSide[] = ['source', 'target'];

export const DEFAULT_GIT_PORT = 4030;
export const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_PUSH_BYTES = 2 * 1024 * 1024 * 1024;

export interface GitSideOptions {
  /** Accepted Basic-auth passwords (tokens). Default `['fake-token']`. */
  tokens?: string[];
  /** Accepted usernames. Default: any non-empty username. */
  usernames?: string[];
  /** Full override of the credential check. */
  authenticate?: (username: string, password: string) => boolean;
  /** Reject pushes containing a blob larger than this. Default: 100 MiB on target, none on source. */
  maxBlobBytes?: number | null;
  /** Reject pushes whose pack is larger than this. Default: 2 GiB on target, none on source. */
  maxPushBytes?: number | null;
  /**
   * Accept pushes (`git-receive-pack`). Default: true on `target`, false on `source` (the migration
   * source is read-only). Seeding does not need it, it writes to the filesystem.
   */
  allowPush?: boolean;
  /**
   * Per-request authorization after a successful credential check: return an HTTP status (403, 404)
   * to refuse, nothing to allow. `repo` is the repository path without `.git`, `operation` is `write`
   * for `git-receive-pack`. Used by the fake GitHub to tie git access to its installation tokens.
   */
  authorize?: (request: {
    username: string;
    password: string;
    repo: string;
    operation: 'read' | 'write';
  }) => number | undefined | Promise<number | undefined>;
  /**
   * With `refPolicyFlag` the pre-receive hook only calls `refPolicy` when the file
   * `{bare repo}/gm-policy-active` exists when the hook runs (faster pushes for repositories without
   * rules). The provider fake keeps the file in step with its rules (`syncPolicyFlag`), so a rule
   * committed before the hook runs is always enforced. Pushes to `refs/pull/*` are denied by the hook
   * itself whenever `refPolicy` is set, flag or not.
   */
  refPolicyFlag?: boolean;
  /**
   * Called when a CGI process (`git http-backend`) is started for a request, before the body is
   * consumed. A test seam to observe that a push is in flight.
   */
  onCgiSpawn?: (info: { repo: string; operation: 'read' | 'write' }) => void;
  /**
   * Ref policy for pushes (pre-receive hook): called per updated ref, return a message to reject the
   * push or nothing to accept. `old`/`new` are object ids (all zeros = absent); `fastForward` is
   * false when `old` is not an ancestor of `new`. Used for branch protection (ADR-0040).
   */
  refPolicy?: (update: {
    username: string;
    password: string;
    repo: string;
    ref: string;
    old: string;
    new: string;
    fastForward: boolean;
  }) => string | undefined | Promise<string | undefined>;
}

export interface FakeGitServerOptions {
  /** Directory holding both sides' repositories and LFS objects. Created if missing. */
  rootDir: string;
  /** Default 4030 (DEV-020). Use 0 for an ephemeral port. */
  port?: number;
  /** Default `127.0.0.1`. */
  host?: string;
  source?: GitSideOptions;
  target?: GitSideOptions;
  /**
   * Base URL clients use to reach this server, used for LFS action links. Default: the listening
   * address (set it when the server is reached by another host name, e.g. in Compose).
   */
  publicUrl?: string;
  /** LFS batch size limit. Default 100 (GitHub's documented default). */
  maxLfsBatchObjects?: number;
  /** How long an LFS action ticket stays valid, in milliseconds. Default 5 minutes. */
  lfsTicketTtlMs?: number;
}

interface SideState {
  tokens: string[];
  usernames?: string[];
  authenticate?: GitSideOptions['authenticate'];
  authorize?: GitSideOptions['authorize'];
  refPolicy?: GitSideOptions['refPolicy'];
  refPolicyFlag?: GitSideOptions['refPolicyFlag'];
  onCgiSpawn?: GitSideOptions['onCgiSpawn'];
  maxBlobBytes: number | null;
  maxPushBytes: number | null;
  allowPush: boolean;
  reposDir: string;
  lfs: LfsObjectStore;
}

/** One git or LFS request the server accepted past authentication, for tests that assert writes. */
export interface GitRequestRecord {
  readonly side: GitSide;
  /** `read` for fetch and LFS download, `write` for a push and an LFS upload. */
  readonly operation: 'read' | 'write';
  readonly method: string;
  readonly path: string;
}

export interface FakeGitServer {
  readonly port: number;
  readonly rootDir: string;
  /** `http://host:port`. */
  readonly baseUrl: string;
  /** Directory of bare repositories for a side. */
  reposDir(side: GitSide): string;
  /** Absolute path of a bare repository, e.g. `repoDir('target', 'acme/app')`. */
  repoDir(side: GitSide, repo: string): string;
  /** Clone URL of a repository (no credentials). */
  repoUrl(side: GitSide, repo: string): string;
  lfsStore(side: GitSide): LfsObjectStore;
  /** Change a side's limits at runtime; `null` disables a limit. */
  setLimits(
    side: GitSide,
    limits: { maxBlobBytes?: number | null; maxPushBytes?: number | null },
  ): void;
  /** Replace a side's accepted tokens at runtime. */
  setTokens(side: GitSide, tokens: string[]): void;
  /** Authenticated requests since the server started or `clearRequests()`, in arrival order. */
  requests(): readonly GitRequestRecord[];
  clearRequests(): void;
  close(): Promise<void>;
}

/** `acme/app` or `acme/app.git` -> `acme/app`; throws on unsafe paths. */
export function normalizeRepoPath(repo: string): string {
  const bare = repo.replace(/\.git$/, '');
  if (
    !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(bare) ||
    bare.split('/').some((s) => /^\.+$/.test(s))
  ) {
    throw new Error(`Invalid repository path: ${repo}`);
  }
  return bare;
}

export async function startFakeGitServer(options: FakeGitServerOptions): Promise<FakeGitServer> {
  assertGitPrerequisites();
  const { rootDir } = options;
  const hooksDir = join(rootDir, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  const hook = join(hooksDir, 'pre-receive');
  await writeFile(hook, PRE_RECEIVE_HOOK);
  await chmod(hook, 0o755);

  const sides = {} as Record<GitSide, SideState>;
  for (const side of GIT_SIDES) {
    const o = options[side] ?? {};
    const reposDir = join(rootDir, side, 'repos');
    await mkdir(reposDir, { recursive: true });
    const isTarget = side === 'target';
    sides[side] = {
      tokens: o.tokens ?? ['fake-token'],
      usernames: o.usernames,
      authenticate: o.authenticate,
      authorize: o.authorize,
      refPolicy: o.refPolicy,
      refPolicyFlag: o.refPolicyFlag,
      onCgiSpawn: o.onCgiSpawn,
      maxBlobBytes:
        o.maxBlobBytes === undefined ? (isTarget ? DEFAULT_MAX_BLOB_BYTES : null) : o.maxBlobBytes,
      maxPushBytes:
        o.maxPushBytes === undefined ? (isTarget ? DEFAULT_MAX_PUSH_BYTES : null) : o.maxPushBytes,
      allowPush: o.allowPush ?? isTarget,
      reposDir,
      lfs: new LfsObjectStore(join(rootDir, side, 'lfs')),
    };
  }
  let baseUrl = '';
  const requestLog: GitRequestRecord[] = [];
  const maxBatch = options.maxLfsBatchObjects ?? 100;

  const server: Server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`fake git server error: ${(error as Error).message}\n`);
    });
  });

  /** Tickets let the pre-receive hook identify the push without the credentials entering its env. */
  const tickets = new Map<
    string,
    { side: SideState; repo: string; username: string; password: string }
  >();
  const policyKey = randomUUID();
  /**
   * LFS action tickets (the `header` of batch actions). A ticket is bound to side, repository and
   * operation (download: GET and HEAD of objects; upload: PUT of objects and verify), expires, and
   * stands for the identity that called the batch endpoint: `authorize` runs for it on every use.
   */
  const lfsTickets = new Map<
    string,
    {
      side: GitSide;
      repo: string;
      operation: 'download' | 'upload';
      expires: number;
      username: string;
      password: string;
    }
  >();
  const ticketTtlMs = options.lfsTicketTtlMs ?? 5 * 60 * 1000;

  function authenticate(side: SideState, header: string | undefined): string | undefined {
    const m = /^Basic (.+)$/i.exec(header ?? '');
    if (!m?.[1]) return undefined;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return undefined;
    const username = decoded.slice(0, i);
    const password = decoded.slice(i + 1);
    if (!username) return undefined;
    if (side.authenticate) return side.authenticate(username, password) ? username : undefined;
    if (side.usernames && !side.usernames.includes(username)) return undefined;
    return side.tokens.includes(password) ? username : undefined;
  }

  /** Internal endpoint for the pre-receive hook: `POST /__policy/{ticket}` with `old new ref ff` lines. */
  async function policy(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ticket = tickets.get((req.url ?? '').split('/').pop() ?? '');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.headers['x-policy-key'] !== policyKey || !ticket) return text(res, 403, 'forbidden\n');
    const messages: string[] = [];
    for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
      const [old, next, ref, ff] = line.split(' ');
      if (!old || !next || !ref) continue;
      const msg = await ticket.side.refPolicy?.({
        username: ticket.username,
        password: ticket.password,
        repo: ticket.repo,
        ref,
        old,
        new: next,
        fastForward: ff !== '0',
      });
      if (msg) messages.push(msg);
    }
    text(res, messages.length ? 409 : 200, messages.join('\n'));
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'POST' && (req.url ?? '').startsWith('/__policy/')) return policy(req, res);
    // Judge the raw target: URL parsing would silently resolve `..` segments.
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (rawPath.split('/').some((seg) => seg === '..' || seg === '.')) {
      return text(res, 404, 'Not found\n');
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^\/(source|target)\/(.+)$/.exec(url.pathname);
    if (!m) return text(res, 404, 'Not found\n');
    const side = sides[m[1] as GitSide];
    const rest = m[2] as string;
    const lfsRoute = /^(.+?)\/info\/lfs(\/.*)$/.exec(rest);
    // Object transfers and verify accept the ticket the batch response handed out instead of
    // credentials; the batch call itself always needs credentials.
    let ticket: (typeof lfsTickets extends Map<string, infer V> ? V : never) | undefined;
    const presented = req.headers[LFS_TICKET_HEADER.toLowerCase()];
    if (lfsRoute && typeof presented === 'string' && lfsRoute[2] !== '/objects/batch') {
      const found = lfsTickets.get(presented);
      const method = req.method ?? 'GET';
      const allowed =
        found?.operation === 'download'
          ? (method === 'GET' || method === 'HEAD') && lfsRoute[2]?.startsWith('/objects/')
          : method === 'PUT' || (method === 'POST' && lfsRoute[2] === '/verify');
      try {
        if (
          found &&
          found.expires > Date.now() &&
          found.side === m[1] &&
          found.repo === normalizeRepoPath(lfsRoute[1] as string) &&
          allowed
        ) {
          ticket = found;
        }
      } catch {
        ticket = undefined;
      }
    }
    const user = ticket ? ticket.username : authenticate(side, req.headers.authorization);
    if (!user) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="fake-git"',
        'content-type': 'text/plain',
      });
      req.resume();
      return void res.end('Authentication required\n');
    }
    const creds = ticket
      ? { username: ticket.username, password: ticket.password }
      : credentials(req.headers.authorization);
    const operation =
      ticket?.operation === 'upload' ||
      rest.endsWith('/git-receive-pack') ||
      url.searchParams.get('service') === 'git-receive-pack'
        ? 'write'
        : 'read';
    requestLog.push({
      side: m[1] as GitSide,
      operation,
      method: req.method ?? 'GET',
      path: url.pathname,
    });
    if (side.authorize && creds) {
      const repoPath = rest.replace(/\.git(\/.*)?$/, '');
      const status = await side.authorize({ ...creds, repo: repoPath, operation });
      if (status !== undefined) {
        req.resume();
        return text(res, status, status === 404 ? 'Repository not found\n' : 'Permission denied\n');
      }
    }
    const lfs = /^(.+?)\/info\/lfs(\/.*)$/.exec(rest);
    if (lfs) {
      let repo: string;
      try {
        repo = normalizeRepoPath(lfs[1] as string);
      } catch {
        return text(res, 404, 'Not found\n');
      }
      if (!existsSync(join(side.reposDir, `${repo}.git`, 'HEAD'))) {
        return text(res, 404, 'Repository not found\n');
      }
      return handleLfs(req, res, {
        store: side.lfs,
        repo,
        lfsUrl: `${baseUrl}/${m[1]}/${repo}.git/info/lfs`,
        subPath: lfs[2] as string,
        maxBatchObjects: maxBatch,
        issueTicket: (operation) => {
          const now = Date.now();
          for (const [key, value] of lfsTickets) if (value.expires <= now) lfsTickets.delete(key);
          const value = randomUUID();
          lfsTickets.set(value, {
            side: m[1] as GitSide,
            repo,
            operation,
            expires: now + ticketTtlMs,
            username: creds?.username ?? '',
            password: creds?.password ?? '',
          });
          return value;
        },
      });
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(rest) || rest.split('/').some((seg) => seg === '..')) {
      return text(res, 404, 'Not found\n');
    }
    return cgi(req, res, side, `/${rest}`, url.search.slice(1), user, creds);
  }

  function cgi(
    req: IncomingMessage,
    res: ServerResponse,
    side: SideState,
    pathInfo: string,
    query: string,
    user: string,
    creds?: { username: string; password: string },
  ): Promise<void> {
    const config: [string, string][] = [
      ['safe.directory', '*'],
      ['http.receivepack', String(side.allowPush)],
      ['transfer.fsckObjects', 'true'],
      ['core.hooksPath', hooksDir],
    ];
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: rootDir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: String(config.length),
      GIT_PROJECT_ROOT: side.reposDir,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method,
      PATH_INFO: pathInfo,
      QUERY_STRING: query,
      REMOTE_USER: user,
      REMOTE_ADDR: req.socket.remoteAddress,
      CONTENT_TYPE: req.headers['content-type'],
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'],
      HTTP_GIT_PROTOCOL: req.headers['git-protocol'] as string | undefined,
    };
    config.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
    let ticketId: string | undefined;
    const policyRepo = pathInfo.replace(/^\//, '').replace(/\.git\/.*$/, '');
    if (side.refPolicy && creds && pathInfo.endsWith('/git-receive-pack')) {
      ticketId = randomUUID();
      tickets.set(ticketId, { side, repo: policyRepo, ...creds });
      env.GM_FAKE_POLICY_URL = `http://127.0.0.1:${port()}/__policy/${ticketId}`;
      env.GM_FAKE_POLICY_KEY = policyKey;
      env.GM_FAKE_NODE = process.execPath;
      if (side.refPolicyFlag) env.GM_FAKE_POLICY_FLAG = POLICY_FLAG_FILE;
    }
    if (side.maxBlobBytes !== null) env.GM_FAKE_MAX_BLOB_BYTES = String(side.maxBlobBytes);
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

    const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    side.onCgiSpawn?.({
      repo: policyRepo,
      operation: pathInfo.endsWith('/git-receive-pack') ? 'write' : 'read',
    });
    const isPush = req.method === 'POST' && pathInfo.endsWith('/git-receive-pack');
    const done = pumpCgi(req, res, child, isPush ? side.maxPushBytes : null);
    return ticketId ? done.finally(() => tickets.delete(ticketId as string)) : done;
  }

  function port(): number {
    return (server.address() as AddressInfo).port;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_GIT_PORT, options.host ?? '127.0.0.1', resolve);
  });
  baseUrl =
    options.publicUrl?.replace(/\/$/, '') ?? `http://${advertisedHost(options.host)}:${port()}`;

  return {
    port: port(),
    rootDir,
    baseUrl,
    reposDir: (side) => sides[side].reposDir,
    repoDir: (side, repo) => join(sides[side].reposDir, `${normalizeRepoPath(repo)}.git`),
    repoUrl: (side, repo) => `${baseUrl}/${side}/${normalizeRepoPath(repo)}.git`,
    lfsStore: (side) => sides[side].lfs,
    setLimits(side, limits) {
      if (limits.maxBlobBytes !== undefined) sides[side].maxBlobBytes = limits.maxBlobBytes;
      if (limits.maxPushBytes !== undefined) sides[side].maxPushBytes = limits.maxPushBytes;
    },
    setTokens(side, tokens) {
      sides[side].tokens = tokens;
    },
    requests: () => [...requestLog],
    clearRequests: () => {
      requestLog.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function credentials(
  header: string | undefined,
): { username: string; password: string } | undefined {
  const m = /^Basic (.+)$/i.exec(header ?? '');
  if (!m?.[1]) return undefined;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? undefined : { username: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

function advertisedHost(host: string | undefined): string {
  return !host || host === '0.0.0.0' || host === '::' ? (host ? 'localhost' : '127.0.0.1') : host;
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

/**
 * Pipes the request into the CGI process and translates its CGI headers into an HTTP response.
 * With `pushLimit`, a request body larger than the limit is drained, the CGI process is killed (so
 * nothing is applied) and the answer is a fixed `413` (ADR-0071).
 */
function pumpCgi(
  req: IncomingMessage,
  res: ServerResponse,
  child: ChildProcess,
  pushLimit: number | null,
): Promise<void> {
  return new Promise((resolve) => {
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (!stdin || !stdout) return resolve();
    stdin.on('error', () => {});
    let exceeded = false;
    let received = 0;
    if (pushLimit === null) {
      req.pipe(stdin);
      req.on('end', () => undefined);
    } else {
      // A push is held back until its size is known. Streaming it to git while counting leaves a
      // race: git's receive-pack (a grandchild that a kill of the CGI does not reach) can apply a
      // pack that is over the limit before the kill lands, and the push then half-succeeds.
      const held: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (exceeded) return;
        if (received > pushLimit) {
          exceeded = true;
          held.length = 0;
          stdin.destroy();
          child.kill();
          return;
        }
        held.push(chunk);
      });
      req.on('end', () => {
        if (exceeded) {
          res.writeHead(413, { 'content-type': 'text/plain' });
          res.end(`fatal: pack exceeds maximum allowed size (${pushLimit} bytes)\n`);
          resolve();
          return;
        }
        // Chunk by chunk, so the pack is never copied into one more buffer.
        for (const chunk of held) stdin.write(chunk);
        stdin.end();
      });
    }
    req.on('aborted', () => child.kill());
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`git http-backend could not start: ${error.message}\n`);
      resolve();
    });
    let head = Buffer.alloc(0);
    let started = false;
    // The CGI prints its headers before receive-pack has read the pack, so the response head is held
    // back until the first body byte (or the end); that keeps a 413 possible while the body streams in.
    let pendingHead: { status: number; headers: Record<string, string> } | undefined;
    const flushHead = () => {
      if (!pendingHead) return;
      res.writeHead(pendingHead.status, pendingHead.headers);
      pendingHead = undefined;
    };
    stdout.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      if (started) {
        flushHead();
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      const endLf = head.indexOf('\n\n');
      const sep =
        end >= 0 && (endLf < 0 || end < endLf)
          ? { at: end, len: 4 }
          : endLf >= 0
            ? { at: endLf, len: 2 }
            : undefined;
      if (!sep) return;
      started = true;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, sep.at).toString('latin1').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
        else headers[name] = value;
      }
      pendingHead = { status, headers };
      const body = head.subarray(sep.at + sep.len);
      if (body.length) {
        flushHead();
        res.write(body);
      }
    });
    child.on('close', () => {
      if (exceeded || res.writableEnded) return;
      if (!started) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`git http-backend failed: ${stderr.trim()}\n`);
      } else {
        flushHead();
        res.end();
      }
      resolve();
    });
  });
}
