/** Guidance content and rendered output (UI-040). */
import type { FindingCode, Severity } from './codes.ts';
import type { ParamName } from './params.ts';

/**
 * One step of guidance. `text` is a message key whose English value is a markdown template in
 * `messages/en.json`. `copy` is a snippet template (not translated) that is rendered only when all
 * of its parameters are present. `link` is an absolute https URL.
 */
export interface GuidanceStep {
  readonly text: string;
  readonly copy?: string;
  readonly link?: string;
  /** Include the step only when this parameter is supplied. */
  readonly when?: ParamName;
  /** Include the step only when this parameter is not supplied. */
  readonly unless?: ParamName;
}

/** Structured guidance for one Finding code. `title`, `summary` and `verification` are message keys. */
export interface Guidance {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly verifiable: boolean;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly GuidanceStep[];
  readonly verification?: string;
}

export interface RenderedStep {
  readonly text: string;
  /** Present only when every placeholder in the snippet was supplied and valid. */
  readonly copy?: string;
  readonly link?: string;
}

export interface RenderedGuidance {
  readonly code: FindingCode;
  readonly severity: Severity;
  readonly verifiable: boolean;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly RenderedStep[];
  readonly verification?: string;
  /** Placeholders that were missing or invalid. Each one appears as `‹name›` in the output. */
  readonly problems: readonly { readonly param: string; readonly reason: string }[];
}

/** Looks up a message by key. Returns undefined when the key is unknown. */
export type MessageLookup = (key: string) => string | undefined;
