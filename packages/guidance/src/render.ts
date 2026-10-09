/** Renders structured guidance into text for a given locale catalog (UI-040). */
import { redactWebhookUrl } from '@git-migrator/canonical';
import type { FindingCode } from './codes.ts';
import { GUIDANCE } from './entries.ts';
import enMessages from './messages/en.json' with { type: 'json' };
import type { ParamValues } from './params.ts';
import { isSupplied, renderLines, renderTemplate, type TemplateProblem } from './template.ts';
import type { MessageLookup, RenderedGuidance, RenderedStep } from './types.ts';

/** A developer error: no entry, or a message key that the catalog does not contain. */
export class GuidanceError extends Error {
  override readonly name = 'GuidanceError';
}

export interface RenderOptions {
  /** Message lookup, for example `nextIntlLookup(t)`. Defaults to the English catalog. */
  readonly lookup?: MessageLookup;
}

const EN: Readonly<Record<string, string>> = enMessages;

/**
 * The flat English catalog, for a host that mounts it under its own guidance namespace with
 * `nestCatalog` (ADR-0093).
 */
export const GUIDANCE_MESSAGES_EN: Readonly<Record<string, string>> = EN;

/** Lookup against the bundled English catalog. */
export const englishLookup: MessageLookup = (key) => (Object.hasOwn(EN, key) ? EN[key] : undefined);

/** True when guidance exists for a Finding code. */
export function hasGuidance(code: string): code is FindingCode {
  return Object.hasOwn(GUIDANCE, code);
}

/**
 * The structural subset of a next-intl translator that the lookup needs. next-intl's `t.raw` returns
 * the message exactly as written, without ICU formatting, which is what guidance templates need: a
 * `{path}` placeholder would otherwise be treated as a missing ICU argument, and an apostrophe as
 * quoting syntax (ADR-0093).
 */
export interface RawMessageTranslator {
  has(key: string): boolean;
  raw(key: string): string;
}

/** Lookup for a next-intl translator scoped to the namespace that holds the guidance catalog. */
export function nextIntlLookup(translator: RawMessageTranslator): MessageLookup {
  return (key) => (translator.has(key) ? translator.raw(key) : undefined);
}

/**
 * The flat catalog as the nested object next-intl resolves dotted keys through. Mount the result
 * under the guidance namespace of the web app's messages. Throws when one key is a prefix of another,
 * because a message cannot also be a namespace.
 */
export function nestCatalog(flat: Readonly<Record<string, string>>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const next = node[part] ?? {};
      if (typeof next !== 'object' || next === null) {
        throw new GuidanceError(`message key ${key} conflicts with a message at ${part}`);
      }
      node[part] = next;
      node = next as Record<string, unknown>;
    }
    const last = parts[parts.length - 1] ?? key;
    if (typeof node[last] === 'object') {
      throw new GuidanceError(`message key ${key} is a prefix of another key`);
    }
    node[last] = value;
  }
  return root;
}

/**
 * The display form of a target URL: `<origin>/…` from canonical's `redactWebhookUrl`, so a secret in
 * the path or query never appears in prose. Only http(s) URLs qualify. `javascript:`, `data:` and
 * `mailto:` URLs (which have no meaningful origin) and unparsable URLs give undefined, and the
 * marker is shown instead (ADR-0092).
 */
export function displayTargetUrl(url: string): string | undefined {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return undefined;
  }
  if (protocol !== 'https:' && protocol !== 'http:') return undefined;
  const shown = redactWebhookUrl(url);
  return shown === '<invalid url>' ? undefined : shown;
}

/**
 * Resolves a message. A lookup that returns the key itself (a sign that the translator echoed it) or
 * a missing key falls back to English. The echo case is reported as a problem.
 */
function message(lookup: MessageLookup, key: string, problems: TemplateProblem[]): string {
  const found = lookup(key);
  if (found !== undefined && found === key) {
    problems.push({ param: key, reason: 'message-fallback' });
  } else if (found !== undefined && found.trim() !== '') {
    return found;
  }
  const english = englishLookup(key);
  if (english === undefined) throw new GuidanceError(`no message for key ${key}`);
  return english;
}

/**
 * Renders the guidance for one finding code with the supplied parameters. Missing or invalid
 * parameters render as `‹name›` and are listed in `problems`. A step whose copy snippet has a
 * problem omits `copy`, so the UI never offers a command that is not ready to run.
 */
export function renderGuidance(
  code: string,
  values: ParamValues,
  options: RenderOptions = {},
): RenderedGuidance {
  if (!hasGuidance(code)) throw new GuidanceError(`no guidance for finding code ${code}`);
  const entry = GUIDANCE[code];
  const lookup = options.lookup ?? englishLookup;
  const effective: ParamValues =
    isSupplied(values.targetUrlDisplay) || typeof values.targetUrl !== 'string'
      ? values
      : { ...values, targetUrlDisplay: displayTargetUrl(values.targetUrl) };
  const problems: TemplateProblem[] = [];
  const text = (key: string): string => {
    const result = renderTemplate(message(lookup, key, problems), effective);
    problems.push(...result.problems);
    return result.text;
  };

  const steps: RenderedStep[] = [];
  for (const step of entry.steps) {
    if (step.when !== undefined && !isSupplied(effective[step.when])) continue;
    if (step.unless !== undefined && isSupplied(effective[step.unless])) continue;
    const rendered: { -readonly [K in keyof RenderedStep]: RenderedStep[K] } = {
      text: text(step.text),
    };
    if (step.copy !== undefined) {
      const lines = renderLines(step.copy, effective);
      problems.push(...lines.problems);
      if (lines.problems.length === 0) rendered.copy = lines.text;
    }
    if (step.link !== undefined) rendered.link = step.link;
    steps.push(rendered);
  }

  const title = text(entry.title);
  const summary = text(entry.summary);
  const verification = entry.verification === undefined ? undefined : text(entry.verification);

  const unique = new Map<string, TemplateProblem>();
  for (const problem of problems) unique.set(`${problem.param}:${problem.reason}`, problem);

  return {
    code: entry.code,
    severity: entry.severity,
    verifiable: entry.verifiable,
    title,
    summary,
    steps,
    ...(verification === undefined ? {} : { verification }),
    problems: [...unique.values()],
  };
}
