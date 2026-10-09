/**
 * Run options (LIF-043, LIF-070). Options travel in the request body `options`; the typed
 * confirmation is the top-level body field `confirm`, never part of the options. Decisions:
 * docs/adr/0343-run-guard-and-findings.md.
 */
import type { RunKind } from '@git-migrator/core';
import { z } from 'zod';

const GIT_KINDS: readonly RunKind[] = ['migrate', 'run_anyway', 'resync'];

/** The options a Run may carry. Strict: an unknown key is refused, not stored. */
export const runOptionsSchema = z.strictObject({
  /** Force-adopt a non-empty target; the ref push becomes a reconcile (LIF-043). */
  adoptNonEmpty: z.boolean().optional(),
  /** Leave the source writable after a successful migration (LIF-070). */
  skipSourceReadOnly: z.boolean().optional(),
});

export type RunOptions = z.infer<typeof runOptionsSchema>;

export type OptionsCheck =
  | { readonly ok: true; readonly options: RunOptions }
  | {
      readonly ok: false;
      readonly code: 'run.options_invalid' | 'run.confirmation_required';
      readonly message: string;
    };

/**
 * Validates the options of a `kind` Run and the typed confirmation. `targetFullName` is the planned
 * target's full name; `adoptNonEmpty` needs `confirm` to equal it exactly (LIF-043).
 */
export function checkRunOptions(input: {
  readonly kind: RunKind;
  readonly options: unknown;
  readonly confirm: string | undefined;
  readonly targetFullName: string | null;
}): OptionsCheck {
  const parsed = runOptionsSchema.safeParse(input.options ?? {});
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    return { ok: false, code: 'run.options_invalid', message: `Invalid Run options: ${paths}` };
  }
  const options = parsed.data;
  // LIF-077: every rollback needs the target's full name typed, as the UI types it (any case).
  // A Migration with no target to name (only Mutations to undo) has nothing to confirm.
  if (
    input.kind === 'rollback' &&
    input.targetFullName !== null &&
    input.confirm?.trim().toLowerCase() !== input.targetFullName.toLowerCase()
  ) {
    return {
      ok: false,
      code: 'run.confirmation_required',
      message: 'a rollback needs confirm set to the target full name',
    };
  }
  if (options.adoptNonEmpty === true) {
    if (!GIT_KINDS.includes(input.kind)) {
      return {
        ok: false,
        code: 'run.options_invalid',
        message: `adoptNonEmpty applies only to ${GIT_KINDS.join(', ')} Runs`,
      };
    }
    if (input.targetFullName === null || input.confirm !== input.targetFullName) {
      return {
        ok: false,
        code: 'run.confirmation_required',
        message: 'adoptNonEmpty needs confirm set to the exact target full name',
      };
    }
  }
  return { ok: true, options };
}
