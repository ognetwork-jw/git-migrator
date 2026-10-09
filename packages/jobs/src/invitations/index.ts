import type { JobHandlers } from '../runtime.ts';
import { runInvitationSend } from './send.ts';
import type { InvitationDeps } from './shared.ts';
import { runInvitationRevoke, runSeatPreview } from './steps.ts';

export { type CorrelateDeps, type CorrelateResult, correlateInvitations } from './correlate.ts';
export { InvitationInterruptedError, runInvitationSend, type SendResult } from './send.ts';
export {
  INVITATION_UNRESOLVED_AFTER_MS,
  type InvitationDeps,
  type InvitationStep,
  invitationTargetLockKey,
  normaliseEmail,
  type ScheduleInvitationStep,
} from './shared.ts';
export {
  type RevokeResult,
  runInvitationRevoke,
  runSeatPreview,
  type SeatPreview,
} from './steps.ts';

/** The `invitations.batch` handler (AUTH-060): seat preview, sending and revoking. */
export function invitationHandlers(deps: InvitationDeps): JobHandlers {
  return {
    'invitations.batch': (payload, ctx) => {
      const options = { shutdown: ctx.shutdown };
      switch (payload.step) {
        case 'seats':
          return runSeatPreview(deps, payload.batchId, options);
        case 'send':
          return runInvitationSend(deps, payload.batchId, options);
        case 'revoke':
          return runInvitationRevoke(deps, payload.batchId, payload.invitationId, options);
      }
    },
  };
}
