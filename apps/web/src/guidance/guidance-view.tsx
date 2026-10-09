'use client';

import {
  hasGuidance,
  isParamName,
  nextIntlLookup,
  type ParamValues,
  type RenderedGuidance,
  renderGuidance,
} from '@git-migrator/guidance';
import { Alert, Tag } from 'antd';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { GUIDANCE_NAMESPACE } from '../messages.ts';
import { CopyButton } from './copy-button.tsx';
import { InlineMarkdown } from './inline-markdown.tsx';

/**
 * The parameters of a finding, as the guidance renderer takes them (UI-040). Only names the guidance
 * knows are passed on; a value of the wrong kind is treated as missing by the renderer, so a bad
 * `params` object can never put `undefined` or `[object Object]` in front of a person.
 * `defaults` fill what the finding does not carry (for example the target repository's full name)
 * and `fieldPaths` stand in for `paths` when the finding does not list them itself.
 */
export function guidanceParams(
  params: unknown,
  extras: {
    readonly defaults?: ParamValues | undefined;
    readonly fieldPaths?: readonly string[] | undefined;
  } = {},
): ParamValues {
  const given: Record<string, unknown> = {};
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    for (const [key, value] of Object.entries(params)) {
      if (isParamName(key)) given[key] = value;
    }
  }
  const merged: Record<string, unknown> = { ...extras.defaults };
  for (const [key, value] of Object.entries(given)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  if (merged.paths === undefined && extras.fieldPaths !== undefined && extras.fieldPaths.length) {
    merged.paths = [...extras.fieldPaths];
  }
  return merged as ParamValues;
}

export interface GuidanceViewProps {
  /** The Finding code (`PlanItem.code` or `ManualTask.code`). */
  readonly code: string;
  /** The finding's `params`, as stored. */
  readonly params?: unknown;
  readonly fieldPaths?: readonly string[] | undefined;
  readonly defaults?: ParamValues | undefined;
  /** Show the title above the summary. Default true. */
  readonly showTitle?: boolean | undefined;
}

const SEVERITY_COLOR: Record<RenderedGuidance['severity'], string> = {
  blocker: 'error',
  pre: 'warning',
  post: 'gold',
  warning: 'default',
};

/**
 * Guidance for one Finding code (UI-040): title, summary, numbered steps with a copy button for each
 * command, and how parity verifies it. Reusable wherever a finding is shown (Overview and Tasks
 * tabs, the endpoint migration page). Rendering never throws: a code without guidance says so.
 */
export function GuidanceView({
  code,
  params,
  fieldPaths,
  defaults,
  showTitle = true,
}: GuidanceViewProps) {
  const t = useTranslations('guidanceView');
  const messages = useTranslations(GUIDANCE_NAMESPACE);
  const rendered = useMemo(() => {
    if (!hasGuidance(code)) return undefined;
    try {
      return renderGuidance(code, guidanceParams(params, { defaults, fieldPaths }), {
        lookup: nextIntlLookup(messages),
      });
    } catch {
      return undefined;
    }
  }, [code, params, defaults, fieldPaths, messages]);

  if (rendered === undefined) {
    return <Alert type="info" showIcon title={t('missing', { code })} />;
  }
  return (
    <div className="flex flex-col gap-2" data-guidance={rendered.code}>
      {showTitle ? (
        <div className="flex flex-wrap items-center gap-2">
          <strong>
            <InlineMarkdown text={rendered.title} />
          </strong>
          <Tag color={SEVERITY_COLOR[rendered.severity]}>{t(`severity.${rendered.severity}`)}</Tag>
          {rendered.verifiable ? <Tag>{t('verifiable')}</Tag> : null}
        </div>
      ) : null}
      <p className="m-0">
        <InlineMarkdown text={rendered.summary} />
      </p>
      {rendered.steps.length > 0 ? (
        <ol className="m-0 flex list-decimal flex-col gap-2 ps-5">
          {rendered.steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps are a fixed, ordered list
            <li key={index}>
              <InlineMarkdown text={step.text} />
              {step.copy !== undefined ? (
                <div className="mt-1 flex flex-wrap items-start gap-2">
                  <pre className="m-0 max-w-full flex-1 overflow-x-auto whitespace-pre rounded p-2 font-mono text-xs">
                    {step.copy}
                  </pre>
                  <CopyButton value={step.copy} label={t('copyWhat', { step: index + 1 })} />
                </div>
              ) : null}
              {step.link !== undefined ? (
                <div>
                  <a href={step.link} target="_blank" rel="noreferrer noopener">
                    {t('openLink')}
                  </a>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {rendered.verification !== undefined ? (
        <p className="m-0 text-sm">
          <InlineMarkdown text={rendered.verification} />
        </p>
      ) : null}
      {rendered.problems.length > 0 ? (
        <p className="m-0 text-sm" role="note">
          {t('incomplete')}
        </p>
      ) : null}
    </div>
  );
}
