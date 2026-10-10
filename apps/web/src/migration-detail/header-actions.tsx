'use client';

import { can } from '@git-migrator/auth/capabilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Modal, Typography } from 'antd';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { useActor } from '../shell/actor-context.tsx';
import { ActionError, type ActionScope } from './action-error.tsx';
import {
  analyze,
  type DetailRunKind,
  detailRootKey,
  type MigrationDetail,
  markComplete,
  type RunRequest,
  type RunSummaryRow,
  revokeComplete,
  startRun,
} from './api.ts';
import { NoteDialog, TypedNameDialog } from './dialogs.tsx';
import {
  type ActionState,
  availableActions,
  forceAdoptKind,
  type HeaderAction,
  targetFullName,
} from './rules.ts';

/** Longest completion reason (the endpoint's bound, ADR-0415). */
const MAX_REASON = 500;

/** Actions that start a Run through a plain confirmation (LIF-005, LIF-040, LIF-070). */
const PLAIN_RUN: Partial<Record<HeaderAction, DetailRunKind>> = {
  migrate: 'migrate',
  run_anyway: 'run_anyway',
  resync: 'resync',
  verify: 'verify',
  source_read_only: 'source_read_only',
};

/** Run kinds that work on the target: a legacy Migration of unknown place confirms them (ADR-0504). */
const TARGET_KINDS: readonly DetailRunKind[] = ['migrate', 'run_anyway', 'resync', 'verify'];

/**
 * What the operator types to confirm a legacy Migration's place: the target full name in the
 * Route's Namespace, or the Namespace path for an endpoint Migration (the server's
 * `legacyConfirmationName`, ADR-0504).
 */
export function legacyConfirmationName(m: MigrationDetail): string {
  const path = m.route.targetNamespacePath;
  return m.scope === 'repository' && m.plannedTargetName ? `${path}/${m.plannedTargetName}` : path;
}

/** Run kinds whose option `skipSourceReadOnly` applies (LIF-070). */
const GIT_KINDS: readonly string[] = ['migrate', 'run_anyway', 'resync'];

function ConfirmDialog({
  open,
  title,
  ok,
  body,
  danger = false,
  loading,
  error,
  errorScope,
  onConfirm,
  onCancel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly ok: string;
  readonly body: ReactNode;
  readonly danger?: boolean;
  readonly loading: boolean;
  readonly error: unknown;
  readonly errorScope: ActionScope;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('migrationDetail.dialog');
  return (
    <Modal
      open={open}
      title={title}
      okText={ok}
      cancelText={t('cancel')}
      okButtonProps={{ danger, loading }}
      cancelButtonProps={{ disabled: loading }}
      onOk={onConfirm}
      onCancel={loading ? undefined : onCancel}
      destroyOnHidden
    >
      <div>{body}</div>
      {error ? (
        <div className="mt-3">
          <ActionError error={error} scope={errorScope} />
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * The header actions of UI-022: Analyze, Migrate, Run anyway, Force adopt, Resync, Verify, Rollback,
 * Apply or undo source read-only, Mark complete or revoke. Each is wired to its endpoint (API-020);
 * a destructive one asks for the exact target full name (UI-001). The server decides again for every
 * request, and its problem code is shown as its own message.
 */
export function HeaderActions({
  migration,
  runs,
}: {
  readonly migration: MigrationDetail;
  readonly runs: readonly RunSummaryRow[];
}) {
  const t = useTranslations('migrationDetail.actions');
  const tDialog = useTranslations('migrationDetail.dialog');
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<HeaderAction | undefined>(undefined);
  const [skipReadOnly, setSkipReadOnly] = useState(false);
  const [started, setStarted] = useState<string | undefined>(undefined);
  const name = targetFullName(migration);
  const actor = useActor();
  // Completion has its own capability (AUTH-020); every other action here is `operate`.
  const states = availableActions(migration, runs).filter(({ action }) =>
    can(
      actor,
      action === 'mark_complete' || action === 'revoke_complete' ? 'markComplete' : 'operate',
    ),
  );
  const activeRun = runs.find((r) => r.status === 'queued' || r.status === 'running');
  const refresh = () => queryClient.invalidateQueries({ queryKey: detailRootKey(migration.id) });
  // Leaving a dialog without confirming also forgets the refusal it showed.
  const dismiss = () => {
    run.reset();
    complete.reset();
    revoke.reset();
    close();
  };
  const close = () => {
    setDialog(undefined);
    setSkipReadOnly(false);
  };

  const run = useMutation({
    mutationFn: (request: RunRequest) => startRun(migration.id, request),
    onSuccess: async (result) => {
      setStarted(result.runId);
      close();
      await refresh();
    },
    // Whatever the server refused, the page it was decided from may be out of date.
    onError: refresh,
  });
  const analysis = useMutation({
    mutationFn: () => analyze(migration.id),
    onMutate: () => setStarted(undefined),
    onSuccess: refresh,
  });
  const complete = useMutation({
    mutationFn: (reason: string) => markComplete(migration.id, reason),
    onSuccess: async () => {
      close();
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: () => revokeComplete(migration.id),
    onSuccess: async () => {
      close();
      await refresh();
    },
  });

  const open = (action: HeaderAction) => {
    run.reset();
    complete.reset();
    revoke.reset();
    setStarted(undefined);
    if (action === 'analyze') analysis.mutate();
    else setDialog(action);
  };
  const startPlain = (kind: DetailRunKind) =>
    run.mutate({
      kind,
      ...(GIT_KINDS.includes(kind) && skipReadOnly
        ? { options: { skipSourceReadOnly: true } }
        : {}),
    });

  const render = ({ action, disabled }: ActionState) => (
    <Button
      key={action}
      type={action === 'migrate' ? 'primary' : 'default'}
      danger={action === 'rollback' || action === 'force_adopt'}
      disabled={disabled !== undefined || analysis.isPending}
      loading={action === 'analyze' && analysis.isPending}
      onClick={() => open(action)}
    >
      {t(`button.${action}`)}
    </Button>
  );
  const asked = dialog;
  const plainKind = asked ? PLAIN_RUN[asked] : undefined;
  const undoFirst = migration.sourceReadOnlyApplied;
  // Legacy target writes of unknown place: every Run on the target, and the rollback, is confirmed
  // by typing the name that names the Route's place (ADR-0504).
  const legacy = migration.targetPlacementUnknown === true;
  const legacyName = legacy ? legacyConfirmationName(migration) : null;
  const legacyKind =
    legacy && plainKind && TARGET_KINDS.includes(plainKind) ? plainKind : undefined;

  return (
    <div className="flex flex-col gap-2">
      <section className="flex flex-wrap gap-2" aria-label={t('label')}>
        {states.map(render)}
      </section>
      {activeRun ? (
        <Typography.Text type="secondary">
          {t('locked')}{' '}
          <Link href={`/runs/${encodeURIComponent(activeRun.id)}`}>{t('openRun')}</Link>
        </Typography.Text>
      ) : null}
      {started ? (
        <Alert
          type="success"
          showIcon
          role="status"
          title={t('started')}
          action={<Link href={`/runs/${encodeURIComponent(started)}`}>{t('openRun')}</Link>}
        />
      ) : null}
      {analysis.isSuccess ? (
        <Alert type="success" showIcon role="status" title={t('analysisQueued')} />
      ) : null}
      {analysis.isError ? <ActionError error={analysis.error} scope="analyze" /> : null}

      <TypedNameDialog
        open={legacyKind !== undefined}
        name={legacyName}
        texts={{
          title: t('confirm.legacy.title'),
          ok: legacyKind ? t(`confirm.${legacyKind}.ok`) : '',
          body: t('confirm.legacy.body', { name: legacyName ?? '' }),
        }}
        warning={t('confirm.legacy.warning')}
        loading={run.isPending}
        error={run.error}
        errorScope="run"
        onConfirm={(typed) => legacyKind && run.mutate({ kind: legacyKind, confirm: typed })}
        onCancel={dismiss}
      />

      <ConfirmDialog
        open={plainKind !== undefined && legacyKind === undefined}
        title={plainKind ? t(`confirm.${plainKind}.title`) : ''}
        ok={plainKind ? t(`confirm.${plainKind}.ok`) : ''}
        danger={plainKind === 'run_anyway'}
        body={
          plainKind ? (
            <div className="flex flex-col gap-3">
              <Typography.Paragraph className="m-0">
                {t(`confirm.${plainKind}.body`, { target: name ?? '' })}
              </Typography.Paragraph>
              {plainKind === 'run_anyway' ? (
                <Alert
                  type="warning"
                  showIcon
                  title={t('confirm.run_anyway.warning', {
                    count: migration.readinessCounts?.preTasks ?? 0,
                  })}
                />
              ) : null}
              {GIT_KINDS.includes(plainKind) ? (
                <Checkbox
                  checked={skipReadOnly}
                  onChange={(e) => setSkipReadOnly(e.target.checked)}
                >
                  {t('skipReadOnly')}
                </Checkbox>
              ) : null}
            </div>
          ) : null
        }
        loading={run.isPending}
        error={run.error}
        errorScope="run"
        onConfirm={() => plainKind && startPlain(plainKind)}
        onCancel={dismiss}
      />

      <TypedNameDialog
        open={asked === 'force_adopt'}
        name={name}
        texts={{
          title: t('confirm.force_adopt.title'),
          ok: t('confirm.force_adopt.ok'),
          body: t('confirm.force_adopt.body', { target: name ?? '' }),
        }}
        warning={t('confirm.force_adopt.warning')}
        loading={run.isPending}
        error={run.error}
        errorScope="run"
        onConfirm={(typed) =>
          run.mutate({
            kind: forceAdoptKind(migration),
            options: { adoptNonEmpty: true, ...(skipReadOnly ? { skipSourceReadOnly: true } : {}) },
            confirm: typed,
          })
        }
        onCancel={dismiss}
      />

      <TypedNameDialog
        open={asked === 'rollback'}
        name={legacy && !undoFirst ? legacyName : name}
        texts={{
          title: undoFirst ? t('confirm.rollback.undoFirstTitle') : t('confirm.rollback.title'),
          ok: undoFirst ? t('confirm.rollback.undoFirstOk') : t('confirm.rollback.ok'),
          body: undoFirst
            ? t('confirm.rollback.undoFirstBody')
            : legacy
              ? t('confirm.legacy.body', { name: legacyName ?? '' })
              : migration.targetCreatedByFramework
                ? t('confirm.rollback.bodyCreated', { target: name ?? '' })
                : t('confirm.rollback.bodyAdopted'),
        }}
        warning={undoFirst ? undefined : t('confirm.rollback.warning')}
        loading={run.isPending}
        error={run.error}
        errorScope="run"
        onConfirm={(typed) =>
          run.mutate({ kind: undoFirst ? 'undo_source_read_only' : 'rollback', confirm: typed })
        }
        onCancel={dismiss}
      />

      <TypedNameDialog
        open={asked === 'undo_source_read_only'}
        name={name}
        texts={{
          title: t('confirm.undo_source_read_only.title'),
          ok: t('confirm.undo_source_read_only.ok'),
          body: t('confirm.undo_source_read_only.body'),
        }}
        loading={run.isPending}
        error={run.error}
        errorScope="run"
        onConfirm={(typed) => run.mutate({ kind: 'undo_source_read_only', confirm: typed })}
        onCancel={dismiss}
      />

      <NoteDialog
        open={asked === 'mark_complete'}
        texts={{
          title: t('confirm.mark_complete.title'),
          ok: t('confirm.mark_complete.ok'),
          body: t('confirm.mark_complete.body'),
        }}
        label={tDialog('reason')}
        required
        maxLength={MAX_REASON}
        loading={complete.isPending}
        error={complete.error}
        errorScope="complete"
        onCancel={dismiss}
        onSubmit={(reason) => complete.mutate(reason)}
      />

      <ConfirmDialog
        open={asked === 'revoke_complete'}
        title={t('confirm.revoke_complete.title')}
        ok={t('confirm.revoke_complete.ok')}
        body={t('confirm.revoke_complete.body')}
        loading={revoke.isPending}
        error={revoke.error}
        errorScope="complete"
        onConfirm={() => revoke.mutate()}
        onCancel={dismiss}
      />
    </div>
  );
}
