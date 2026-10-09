/** Small helpers the Run, task and Expected Difference endpoints share (API-020). */
import { type Capability, can } from '@git-migrator/auth';
import type { z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Principal } from './principal.ts';
import { ProblemError, ProblemSchema } from './problem.ts';

export interface Env {
  Variables: { principal: Principal };
}

const problemContent = { 'application/problem+json': { schema: ProblemSchema } };
export const problems = (...codes: (401 | 403 | 404 | 409 | 422 | 503)[]) =>
  Object.fromEntries(
    codes.map((status) => [status, { description: 'Problem', content: problemContent }]),
  );
export const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });
export const security: Record<string, string[]>[] = [{ bearerAuth: [] }, { sessionCookie: [] }];

export function requireCapability(c: Context<Env>, capability: Capability): void {
  if (!can(c.get('principal').actor, capability)) {
    throw new ProblemError('forbidden', { detail: `requires the ${capability} capability` });
  }
}

/** The shape every route module's `validationHook` has (the 422 problem of `createV1`). */
export type ValidationHook = (result: { success: boolean; error?: z.ZodError }, c: Context) => void;
