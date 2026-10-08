import { expect } from 'vitest';
import { createFakeGitHub, type FakeGitHub } from './app.ts';
import type { FakeGitHubOptions } from './config.ts';
import { validateAgainstSpec } from './spec-validation.ts';
import type { RepoRec } from './types.ts';

export interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: tests index into untyped JSON bodies
  body: any;
  headers: Headers;
}

/** Parses a JSON response of the app without typing it (tests index into GitHub-shaped bodies). */
// biome-ignore lint/suspicious/noExplicitAny: see Reply.body
export const jsonOf = (res: Response): Promise<any> => res.json();

/** Narrowing helper for tests: fails loudly instead of using `!`. */
export function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

export interface World {
  fake: FakeGitHub;
  /** Installation token of the default installation (organization `acme`). */
  token: string;
  call(
    method: string,
    path: string,
    init?: { body?: unknown; token?: string | null; headers?: Record<string, string> },
  ): Promise<Reply>;
  /** Calls and validates the response against the saved OpenAPI description. */
  spec(
    template: string,
    method: string,
    path: string,
    init?: { body?: unknown; token?: string | null; headers?: Record<string, string> },
    expectStatus?: number,
  ): Promise<Reply>;
  repo: RepoRec;
  emptyRepo: RepoRec;
}

export const FILES = {
  'README.md': '# auto-ok\n',
  'src/a.txt': 'a\nb\n',
  'src/nested/c.txt': 'c\n',
  '.github/CODEOWNERS': '* @acme/platform\n',
};

/** Organization `acme` with members alice (owner) and bob, an outside user carol, two repositories. */
export function world(options: FakeGitHubOptions = {}): World {
  const fake = createFakeGitHub(options);
  const { state } = fake;
  state.addMember('acme', 'alice', 'admin');
  state.addMember('acme', 'bob');
  state.addUser({ login: 'carol', email: 'carol@test.local' });
  state.addUser({ login: 'dave', name: 'Dave D', publicEmail: 'dave@test.local' });
  const repo = state.addRepository('acme', {
    name: 'auto-ok',
    private: true,
    description: 'hello',
    files: FILES,
  });
  state.addBranch(
    repo,
    'feature/x',
    { ...FILES, 'src/new.txt': 'new\n' },
    { from: 'main', message: 'Add new' },
  );
  const emptyRepo = state.addRepository('acme', { name: 'empty', private: true });
  const token = fake.token();
  const call: World['call'] = async (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    const t = init.token === undefined ? token : init.token;
    if (t) headers.authorization = `Bearer ${t}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fake.app.request(path, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: see Reply.body
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // keep text
    }
    return { status: res.status, body, headers: res.headers };
  };
  const spec: World['spec'] = async (template, method, path, init, expectStatus) => {
    const reply = await call(method.toUpperCase(), path, init);
    if (expectStatus !== undefined)
      expect(reply.status, JSON.stringify(reply.body)).toBe(expectStatus);
    const check = validateAgainstSpec(method, template, reply.status, reply.body);
    expect(check.errors, `${method} ${template} -> ${reply.status}`).toEqual([]);
    return reply;
  };
  return { fake, token, call, spec, repo, emptyRepo };
}
