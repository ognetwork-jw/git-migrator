import type { Actor } from './api/actor.ts';

/** Fixtures shared by the Actor and audit page tests (UI-034, UI-035). Used only by tests. */

export const ME: Actor = {
  id: 'me',
  displayName: 'Ada',
  email: 'ada@example.test',
  role: 'admin',
  disabled: false,
};

export const ACTORS = [
  {
    id: 'me',
    kind: 'human',
    displayName: 'Ada',
    email: 'ada@example.test',
    role: 'admin',
    disabled: false,
  },
  {
    id: 'a2',
    kind: 'human',
    displayName: 'Grace',
    email: 'grace@example.test',
    role: 'viewer',
    disabled: false,
  },
  {
    id: 'bot',
    kind: 'service',
    displayName: 'Release bot',
    email: null,
    role: 'operator',
    disabled: false,
  },
];

export const KEY = {
  id: 'k1',
  name: 'nightly',
  prefix: 'abcd1234',
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
};

export const ISSUED_KEY = 'gm_abcd1234EXAMPLEONLYSECRETVALUE0000000000';
