'use client';

import { Alert } from 'antd';
import { useTranslations } from 'next-intl';
import { ApiError } from '../api/http.ts';

/** The actions that can fail, each with its own texts for the problem codes it can meet. */
export type ActionScope =
  | 'run'
  | 'cancel'
  | 'analyze'
  | 'complete'
  | 'task'
  | 'difference'
  | 'wave'
  | 'note';

/**
 * A failed action. The text is chosen by the action and the problem `code`
 * (`migrationDetail.error.<action>.<code>`), then by the code alone (`problem.<code>`), then the
 * generic text. Every Run problem code (`run_active`, `readiness_required`, `confirmation_required`,
 * `run_not_permitted`) therefore reads as its own sentence (API-011).
 */
export function ActionError({
  error,
  scope,
  name,
}: {
  readonly error: unknown;
  readonly scope: ActionScope;
  /** The name the confirmation asked for; a refused confirmation names it (ADR-0504). */
  readonly name?: string | null | undefined;
}) {
  const own = useTranslations('migrationDetail.error');
  const problems = useTranslations('problem');
  const code = error instanceof ApiError ? error.code : 'internal_error';
  const key = `${scope}.${code}`;
  const named = `${key}_named`;
  const text =
    name && own.has(named as never)
      ? own(named as never, { name } as never)
      : own.has(key as never)
        ? own(key as never)
        : problems.has(code)
          ? problems(code)
          : problems('internal_error');
  return <Alert type="error" showIcon role="alert" title={text} />;
}
