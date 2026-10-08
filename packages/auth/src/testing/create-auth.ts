import {
  type AuthService,
  type AuthTestSeams,
  type CreateAuthOptions,
  createAuthWithSeams,
} from '../auth.ts';

export type { AuthTestSeams } from '../auth.ts';

/**
 * `createAuth` for tests: `seams.entraAuthority` points sign-in at the local Entra stub, and
 * `seams.mutateEntraDecision` rewrites the decision of the profile gate. The production
 * `createAuth` does not take either.
 */
export function createAuthForTest(options: CreateAuthOptions, seams: AuthTestSeams): AuthService {
  return createAuthWithSeams(options, seams);
}
