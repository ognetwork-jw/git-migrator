export {
  AUDIT_ACTOR_CREATED,
  AUDIT_ACTOR_ROLE_CHANGED,
  type EntraActorInput,
  linkTestActor,
  type ProvisionResult,
  provisionMappedActor,
} from './actors.ts';
export {
  AUTH_BASE_PATH,
  AUTH_ERROR_CODES,
  type AuthErrorCode,
  type AuthSecrets,
  type AuthService,
  type CreateAuthOptions,
  createAuth,
  DISABLED_PATH_PREFIXES,
  DISABLED_PATHS,
  ENTRA_METHOD,
  ENTRA_SCOPES,
  MAX_AUTH_BODY_BYTES,
  normalizeTenantId,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  syntheticEmail,
} from './auth.ts';
export { betterAuthLogger, scrubEmails } from './logger.ts';
export { methodHasMappings, outranks, type Role, type RoleMapping, resolveRole } from './roles.ts';
export { createAuthPool, migrateAuthSchema } from './storage.ts';
export {
  assertTestSignInAllowed,
  createCredentialUser,
  seedTestSignInUsers,
  type TestUserSeedResult,
} from './test-sign-in.ts';

/** The workspace package name (ARC-011). */
export const PACKAGE_NAME = '@git-migrator/auth';
