import { asRecord } from './ports.ts';
import type { AppPort } from './reset.ts';

/** `localhost`, `[::1]` or a full dotted quad with first octet 127 (the URL parser normalises `127.1`). */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The running app's API as the test operator (test sign-in, AUTH-012), for `resetLive`. It only
 * starts the app's own Runs; it never reads the database directly.
 */
export function createAppPort(
  options: {
    baseUrl: string;
    email: string;
    password: string;
    /** The fixture repository, scoped to its source Endpoint and project. */
    slug: string;
    endpointId: string;
    projectKey: string;
    timeoutMs?: number;
  },
  fetchImpl: typeof fetch = fetch,
): AppPort {
  // The password of the test operator goes to this URL: only a local app may receive it.
  const host = new URL(options.baseUrl).hostname;
  if (!isLoopbackHost(host)) {
    throw new Error(`GM_E2E_APP_URL must be a local address (it is ${host}).`);
  }
  const origin = new URL(options.baseUrl).origin;
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers: {
        origin,
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { response, json };
  };
  const signIn = async () => {
    if (cookie) return;
    const { response } = await call('POST', '/api/auth/sign-in/email', {
      email: options.email,
      password: options.password,
    });
    if (response.status !== 200)
      throw new Error(`the app refused the sign-in (HTTP ${response.status})`);
    cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
  };
  const model = async (name: string, op: string, args: unknown) => {
    const { response, json } = await call(
      'GET',
      `/api/model/${name}/${op}?q=${encodeURIComponent(JSON.stringify(args))}`,
    );
    if (response.status !== 200) throw new Error(`${name}/${op} answered HTTP ${response.status}`);
    return asRecord(json).data;
  };
  return {
    async find() {
      await signIn();
      const row = asRecord(
        await model('migration', 'findFirst', {
          where: {
            scope: 'repository',
            sourceRepository: {
              slug: options.slug,
              endpointId: options.endpointId,
              namespace: { key: options.projectKey },
            },
          },
          select: { id: true, sourceReadOnlyApplied: true, targetRepositoryId: true, status: true },
        }),
      );
      if (typeof row.id !== 'string') return undefined;
      return {
        id: row.id,
        sourceReadOnlyApplied: row.sourceReadOnlyApplied === true,
        // A rolled-back Migration has nothing left to roll back.
        hasTarget: row.targetRepositoryId != null && row.status !== 'rolled_back',
      };
    },
    async run(migrationId, kind, confirm) {
      await signIn();
      const started = await call('POST', `/api/v1/migrations/${migrationId}/runs`, {
        kind,
        ...(confirm === undefined ? {} : { confirm }),
      });
      if (started.response.status !== 202) {
        throw new Error(`starting a ${kind} Run answered HTTP ${started.response.status}`);
      }
      const runId = String(asRecord(started.json).runId ?? '');
      const deadline = Date.now() + (options.timeoutMs ?? 300_000);
      for (;;) {
        const run = asRecord(
          await model('run', 'findUnique', { where: { id: runId }, select: { status: true } }),
        );
        const status = String(run.status ?? '');
        if (status && status !== 'queued' && status !== 'running') return status;
        if (Date.now() > deadline)
          throw new Error(`the ${kind} Run ${runId} did not finish in time`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
  };
}
