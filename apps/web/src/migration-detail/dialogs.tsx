'use client';

import { Alert, Input, Modal, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { type ReactNode, useId, useState } from 'react';
import { ActionError, type ActionScope } from './action-error.tsx';

export interface DialogTexts {
  readonly title: string;
  readonly ok: string;
  readonly body?: ReactNode;
}

/**
 * A dialog that asks for a short note before an action (a completion reason, a dismissal note, the
 * reason an Expected Difference is accepted). `required` keeps the button off until the text is
 * not blank; `maxLength` mirrors the server's bound.
 */
export function NoteDialog({
  open,
  texts,
  label,
  required,
  maxLength,
  danger = false,
  loading,
  error,
  errorScope,
  onSubmit,
  onCancel,
}: {
  readonly open: boolean;
  readonly texts: DialogTexts;
  readonly label: string;
  readonly required: boolean;
  readonly maxLength: number;
  readonly danger?: boolean;
  readonly loading: boolean;
  readonly error: unknown;
  readonly errorScope: ActionScope;
  readonly onSubmit: (note: string) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('migrationDetail.dialog');
  const [note, setNote] = useState('');
  const labelId = useId();
  const blank = note.trim() === '';
  return (
    <Modal
      open={open}
      title={texts.title}
      okText={texts.ok}
      cancelText={t('cancel')}
      okButtonProps={{ danger, loading, disabled: required && blank }}
      cancelButtonProps={{ disabled: loading }}
      onOk={() => onSubmit(note.trim())}
      onCancel={loading ? undefined : onCancel}
      afterClose={() => setNote('')}
      destroyOnHidden
    >
      {texts.body ? <Typography.Paragraph>{texts.body}</Typography.Paragraph> : null}
      <div className="flex flex-col gap-1">
        <span id={labelId}>{label}</span>
        <Input.TextArea
          aria-labelledby={labelId}
          value={note}
          maxLength={maxLength}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          showCount
        />
      </div>
      {error ? (
        <div className="mt-3">
          <ActionError error={error} scope={errorScope} />
        </div>
      ) : null}
    </Modal>
  );
}

/** True when `typed` is exactly the full name (UI-001: the exact target full name, no folding). */
export const matchesName = (typed: string, name: string): boolean => typed === name;

/**
 * The destructive confirmation (UI-001): rollback, force-adopt and undoing the source's read-only
 * state need the exact target full name typed. With no `name` (a rollback of a Migration that has
 * no target to name, only Mutations to undo) there is nothing to type and the button is enabled.
 */
export function TypedNameDialog({
  open,
  name,
  texts,
  warning,
  loading,
  error,
  errorScope,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly name: string | null;
  readonly texts: DialogTexts;
  readonly warning?: string | undefined;
  readonly loading: boolean;
  readonly error: unknown;
  readonly errorScope: ActionScope;
  readonly onConfirm: (typed: string) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('migrationDetail.dialog');
  const [typed, setTyped] = useState('');
  const labelId = useId();
  const ok = name === null || matchesName(typed, name);
  return (
    <Modal
      open={open}
      title={texts.title}
      okText={texts.ok}
      cancelText={t('cancel')}
      okButtonProps={{ danger: true, loading, disabled: !ok }}
      cancelButtonProps={{ disabled: loading }}
      onOk={() => onConfirm(typed)}
      onCancel={loading ? undefined : onCancel}
      afterClose={() => setTyped('')}
      destroyOnHidden
    >
      {texts.body ? <Typography.Paragraph>{texts.body}</Typography.Paragraph> : null}
      {warning ? <Alert className="mb-3" type="warning" showIcon title={warning} /> : null}
      {name !== null ? (
        <div className="flex flex-col gap-1">
          <span id={labelId}>
            {t('typeName')} <strong className="font-mono">{name}</strong>
          </span>
          <Input
            aria-labelledby={labelId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            status={typed !== '' && !ok ? 'error' : undefined}
          />
        </div>
      ) : null}
      {error ? (
        <div className="mt-3">
          <ActionError error={error} scope={errorScope} name={name} />
        </div>
      ) : null}
    </Modal>
  );
}
