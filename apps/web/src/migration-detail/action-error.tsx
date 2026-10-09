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
}: {
  readonly error: unknown;
  readonly scope: ActionScope;
}) {
  const own = useTranslations('migrationDetail.error');
  const problems = useTranslations('problem');
  const code = error instanceof ApiError ? error.code : 'internal_error';
  const key = `${scope}.${code}`;
  const text = own.has(key as never)
    ? own(key as never)
    : problems.has(code)
      ? problems(code)
      : problems('internal_error');
  return <Alert type="error" showIcon role="alert" title={text} />;
}
