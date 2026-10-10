/**
 * Guidance parameters that may carry a credential (ADR-0503). A webhook's `targetUrl` may hold a
 * secret in its path or query (FAC-WEB-002), and the recreate guidance needs it whole for its copy
 * snippet. The persistence layer stores such parameters apart (`secretParams`), where viewers
 * cannot read them, and keeps their display form (`targetUrlDisplay`) with the other parameters.
 */
import type { ParamName } from './params.ts';
import { displayTargetUrl } from './render.ts';

/** Parameters stored only in `secretParams`. */
export const SECRET_PARAMS: readonly ParamName[] = ['targetUrl'];

export interface SplitParams {
  /** Everything but the secret parameters, plus the display form of `targetUrl`. */
  readonly params: Record<string, unknown>;
  /** The secret parameters, or null when there are none. */
  readonly secretParams: Record<string, unknown> | null;
}

/** Splits finding parameters into the part every role may read and the secret part. */
export function splitSecretParams(all: Readonly<Record<string, unknown>>): SplitParams {
  const params: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(all)) {
    if ((SECRET_PARAMS as readonly string[]).includes(name)) secret[name] = value;
    else params[name] = value;
  }
  if (typeof secret.targetUrl === 'string' && params.targetUrlDisplay === undefined) {
    const display = displayTargetUrl(secret.targetUrl);
    if (display !== undefined) params.targetUrlDisplay = display;
  }
  return { params, secretParams: Object.keys(secret).length > 0 ? secret : null };
}

/** The parameters a guidance render gets: the readable ones, with the secret ones when readable. */
export function joinSecretParams(params: unknown, secretParams: unknown): Record<string, unknown> {
  const object = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { ...object(params), ...object(secretParams) };
}
