import type { Config } from '@git-migrator/config';
import { TEST_ACTORS } from '@git-migrator/db';
import type { AuthService } from './auth.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * AUTH-012 (Q66): startup MUST abort when test sign-in is enabled in production. The production
 * signal is the validated `environment` or the raw `GM_ENVIRONMENT`, so a config that lost its
 * `environment` key cannot slip through while the variable says production.
 */
export function assertTestSignInAllowed(
  config: Pick<Config, 'environment' | 'auth'>,
  env: Env,
): void {
  if (!config.auth.testSignIn.enabled) return;
  if (config.environment === 'production' || env.GM_ENVIRONMENT === 'production') {
    throw new Error(
      'auth.testSignIn.enabled must be false when GM_ENVIRONMENT is production (AUTH-012)',
    );
  }
}

export interface TestUserSeedResult {
  readonly created: number;
  readonly passwordUpdated: number;
}

/**
 * AUTH-012: creates the Better Auth user and password account for each seeded test Actor
 * (`viewer@`, `operator@`, `admin@test.local`) with the password from `GM_TEST_USER_PASSWORD`.
 * Idempotent: an existing user keeps its row, and its password is replaced only when it no longer
 * matches. Refuses to run unless test sign-in is enabled, and never in production. The Actors are
 * linked to these users by email at the first sign-in (ADR-0121 item 9).
 */
export async function seedTestSignInUsers(
  service: AuthService,
  options: { config: Pick<Config, 'environment' | 'auth'>; env: Env; password: string },
): Promise<TestUserSeedResult> {
  assertTestSignInAllowed(options.config, options.env);
  if (!options.config.auth.testSignIn.enabled) {
    throw new Error('seeding test sign-in users needs auth.testSignIn.enabled (AUTH-012)');
  }
  if (options.password === '') {
    throw new Error('GM_TEST_USER_PASSWORD is required to seed test sign-in users (AUTH-012)');
  }
  const context = await service.auth.$context;
  const hash = await context.password.hash(options.password);
  let created = 0;
  let passwordUpdated = 0;
  for (const spec of TEST_ACTORS) {
    const existing = await context.internalAdapter.findUserByEmail(spec.email, {
      includeAccounts: true,
    });
    if (!existing) {
      await createCredentialUser(service, {
        email: spec.email,
        name: spec.displayName,
        passwordHash: hash,
      });
      created++;
      continue;
    }
    const credential = existing.accounts.find((a) => a.providerId === 'credential');
    if (!credential) {
      await context.internalAdapter.createAccount({
        userId: existing.user.id,
        providerId: 'credential',
        accountId: existing.user.id,
        password: hash,
      });
      created++;
    } else if (
      !credential.password ||
      !(await context.password.verify({ hash: credential.password, password: options.password }))
    ) {
      await context.internalAdapter.updatePassword(existing.user.id, hash);
      passwordUpdated++;
    }
  }
  return { created, passwordUpdated };
}

/**
 * Creates a Better Auth user with a password account directly in the store (test sign-in users have
 * no sign-up endpoint, AUTH-012). Used by the seed script and by tests.
 */
export async function createCredentialUser(
  service: AuthService,
  input: { email: string; name: string; passwordHash: string },
): Promise<string> {
  const context = await service.auth.$context;
  const now = new Date();
  const id = context.generateId({ model: 'user' }) || crypto.randomUUID();
  await context.adapter.create({
    model: 'user',
    forceAllowId: true,
    data: {
      id,
      email: input.email.toLowerCase(),
      name: input.name,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  await context.internalAdapter.createAccount({
    userId: id,
    providerId: 'credential',
    accountId: id,
    password: input.passwordHash,
  });
  return id;
}
