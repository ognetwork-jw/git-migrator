export {
  AUDIT_ACTOR_CREATED,
  AUDIT_ACTOR_ROLE_CHANGED,
  type EntraActorInput,
  linkTestActor,
  type ProvisionResult,
  provisionMappedActor,
} from './actors.ts';
export {
  API_KEY_PATTERN,
  ApiKeyError,
  type ApiKeyErrorCode,
  type ApiKeyVerification,
  AUDIT_API_KEY_ISSUED,
  AUDIT_API_KEY_REVOKED,
  generateApiKey,
  hashApiKey,
  type IssueApiKeyInput,
  type IssuedApiKey,
  issueApiKey,
  LAST_USED_INTERVAL_MS,
  revokeApiKey,
  verifyApiKey,
} from './api-keys.ts';
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
export {
  type Authorizable,
  CAPABILITY_MIN_ROLE,
  type Capability,
  can,
} from './capabilities.ts';
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
