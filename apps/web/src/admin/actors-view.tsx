'use client';

import { CopyOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ApiError } from '../api/http.ts';
import { formatDateTime } from '../format.ts';
import { ErrorAlert } from '../mapping/shared.tsx';
import { useActor } from '../shell/actor-context.tsx';
import { ROLES } from '../shell/navigation.ts';
import {
  type ActorRow,
  type ApiKeyRow,
  actorsKey,
  apiKeysKey,
  createServiceActor,
  fetchActors,
  fetchApiKeys,
  type IssuedKey,
  issueApiKey,
  type RoleName,
  revokeApiKey,
  setActorDisabled,
} from './api.ts';

const MAX_NAME = 200;

/** Whether a key still works: not revoked, and not past its expiry. */
export function keyStatus(key: ApiKeyRow, now: number): 'revoked' | 'expired' | 'active' {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

/** The expiry from a `datetime-local` value, as an ISO instant, or `undefined` for none. */
export function expiryFromLocal(value: string): string | undefined {
  if (value.trim() === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** UI-034: actors (human and service), service Actor creation, disabling, and API keys. */
export function ActorsView() {
  const t = useTranslations('admin.actors');
  const me = useActor();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const actors = useQuery({ queryKey: actorsKey, queryFn: fetchActors });

  const setDisabled = useMutation({
    mutationFn: (v: { actor: ActorRow; disabled: boolean }) =>
      setActorDisabled(v.actor.id, v.disabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: actorsKey }),
  });

  return (
    <div className="flex flex-col gap-4">
      <Space wrap>
        <Button
          type="primary"
          icon={<PlusOutlined aria-hidden />}
          onClick={() => setCreating(true)}
        >
          {t('create')}
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">{t('help')}</Typography.Paragraph>

      {actors.isError ? <ErrorAlert error={actors.error} /> : null}
      {setDisabled.isError ? <ErrorAlert error={setDisabled.error} /> : null}

      <Table<ActorRow>
        rowKey="id"
        size="middle"
        loading={actors.isLoading || actors.isFetching}
        dataSource={actors.data ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        expandable={{
          rowExpandable: (r) => r.kind === 'service',
          expandedRowRender: (r) => <ApiKeysPanel actor={r} />,
        }}
        columns={[
          {
            title: t('column.name'),
            key: 'name',
            render: (_: unknown, a) => (
              <div>
                <div>{a.displayName}</div>
                {a.email ? (
                  <Typography.Text type="secondary" className="text-xs">
                    {a.email}
                  </Typography.Text>
                ) : null}
              </div>
            ),
          },
          {
            title: t('column.kind'),
            key: 'kind',
            render: (_: unknown, a) => <Tag>{t(`kind.${a.kind}`)}</Tag>,
          },
          {
            title: t('column.role'),
            key: 'role',
            render: (_: unknown, a) => t(`role.${a.role}`),
          },
          {
            title: t('column.status'),
            key: 'status',
            render: (_: unknown, a) => (
              <Tag color={a.disabled ? 'default' : 'success'}>
                {a.disabled ? t('status.disabled') : t('status.enabled')}
              </Tag>
            ),
          },
          {
            title: t('column.actions'),
            key: 'actions',
            render: (_: unknown, a) => {
              const self = a.id === me.id;
              if (a.disabled) {
                return (
                  <Button
                    size="small"
                    loading={setDisabled.isPending && setDisabled.variables?.actor.id === a.id}
                    onClick={() => setDisabled.mutate({ actor: a, disabled: false })}
                  >
                    {t('enable')}
                  </Button>
                );
              }
              return (
                <Popconfirm
                  title={t('disableTitle', { name: a.displayName })}
                  description={t('disableBody')}
                  okText={t('disable')}
                  cancelText={t('cancel')}
                  okButtonProps={{ danger: true }}
                  disabled={self}
                  onConfirm={() => setDisabled.mutate({ actor: a, disabled: true })}
                >
                  <Button
                    size="small"
                    danger
                    disabled={self}
                    title={self ? t('selfHint') : undefined}
                  >
                    {t('disable')}
                  </Button>
                </Popconfirm>
              );
            },
          },
        ]}
      />

      {creating ? <CreateActorModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function CreateActorModal({ onClose }: { readonly onClose: () => void }) {
  const t = useTranslations('admin.actors');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [role, setRole] = useState<RoleName>('viewer');
  const trimmed = name.trim();

  const create = useMutation({
    mutationFn: () => createServiceActor(trimmed, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: actorsKey });
      onClose();
    },
  });

  return (
    <Modal
      open
      destroyOnHidden
      title={t('modal.createTitle')}
      okText={t('modal.create')}
      cancelText={t('cancel')}
      okButtonProps={{ disabled: trimmed === '' || create.isPending }}
      onCancel={onClose}
      onOk={() => create.mutate()}
    >
      <div className="flex flex-col gap-3">
        <Input
          aria-label={t('modal.name')}
          placeholder={t('modal.namePlaceholder')}
          value={name}
          maxLength={MAX_NAME}
          onChange={(e) => setName(e.target.value)}
        />
        <Select<RoleName>
          aria-label={t('modal.role')}
          value={role}
          onChange={setRole}
          options={ROLES.map((r) => ({ value: r, label: t(`role.${r}`) }))}
        />
        {create.isError ? <ErrorAlert error={create.error} /> : null}
      </div>
    </Modal>
  );
}

/** The keys of one service Actor: the list (prefix only), issue and revoke. */
function ApiKeysPanel({ actor }: { readonly actor: ActorRow }) {
  const t = useTranslations('admin.actors.keys');
  const queryClient = useQueryClient();
  const [issuing, setIssuing] = useState(false);
  const keys = useQuery({
    queryKey: apiKeysKey(actor.id),
    queryFn: () => fetchApiKeys(actor.id),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: apiKeysKey(actor.id) }),
  });
  const now = Date.now();

  return (
    <div className="flex flex-col gap-3 py-2">
      <Space>
        <Button size="small" icon={<PlusOutlined aria-hidden />} onClick={() => setIssuing(true)}>
          {t('issue')}
        </Button>
      </Space>
      {keys.isError ? <ErrorAlert error={keys.error} /> : null}
      {revoke.isError ? <ErrorAlert error={revoke.error} /> : null}
      <Table<ApiKeyRow>
        rowKey="id"
        size="small"
        pagination={false}
        loading={keys.isLoading}
        dataSource={keys.data ?? []}
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: t('empty') }}
        columns={[
          { title: t('column.name'), key: 'name', render: (_: unknown, k) => k.name },
          {
            title: t('column.prefix'),
            key: 'prefix',
            render: (_: unknown, k) => <Typography.Text code>{`gm_${k.prefix}…`}</Typography.Text>,
          },
          {
            title: t('column.created'),
            key: 'created',
            render: (_: unknown, k) => formatDateTime(k.createdAt),
          },
          {
            title: t('column.lastUsed'),
            key: 'lastUsed',
            render: (_: unknown, k) =>
              k.lastUsedAt ? formatDateTime(k.lastUsedAt) : t('neverUsed'),
          },
          {
            title: t('column.expires'),
            key: 'expires',
            render: (_: unknown, k) => (k.expiresAt ? formatDateTime(k.expiresAt) : t('noExpiry')),
          },
          {
            title: t('column.status'),
            key: 'status',
            render: (_: unknown, k) => {
              const status = keyStatus(k, now);
              return (
                <Tag color={status === 'active' ? 'success' : 'default'}>
                  {t(`status.${status}`)}
                </Tag>
              );
            },
          },
          {
            title: t('column.actions'),
            key: 'actions',
            render: (_: unknown, k) =>
              k.revokedAt ? null : (
                <Popconfirm
                  title={t('revokeTitle', { name: k.name })}
                  description={t('revokeBody')}
                  okText={t('revoke')}
                  cancelText={t('cancel')}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => revoke.mutate(k.id)}
                >
                  <Button size="small" danger>
                    {t('revoke')}
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
      {issuing ? (
        <IssueKeyModal
          actorId={actor.id}
          onClose={() => {
            setIssuing(false);
            void queryClient.invalidateQueries({ queryKey: apiKeysKey(actor.id) });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Issues a key and shows it once. The key lives in this component's state only: it is not handed to
 * a query or mutation cache, not stored in the browser, and not logged. Closing the dialog unmounts
 * it, and with it the key (AUTH-040, ADR-0365).
 */
function IssueKeyModal({
  actorId,
  onClose,
}: {
  readonly actorId: string;
  readonly onClose: () => void;
}) {
  const t = useTranslations('admin.actors.keys');
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [issued, setIssued] = useState<IssuedKey>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const trimmed = name.trim();
  const expiresAt = expiryFromLocal(expires);
  const expiryPast =
    expires !== '' && (expiresAt === undefined || new Date(expiresAt).getTime() <= Date.now());

  if (issued) {
    return (
      <Modal
        open
        destroyOnHidden
        title={t('once.title')}
        // The key is shown once: only Done closes the dialog, not Escape, the backdrop or a close icon.
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={
          <Button type="primary" onClick={onClose}>
            {t('once.done')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <Alert type="warning" showIcon title={t('once.warning')} />
          <Space.Compact className="w-full">
            <Input
              aria-label={t('once.keyLabel')}
              readOnly
              value={issued.key}
              className="font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              icon={<CopyOutlined aria-hidden />}
              onClick={() => {
                const write = navigator.clipboard?.writeText(issued.key);
                if (write === undefined) {
                  setCopied('failed');
                  return;
                }
                void write.then(
                  () => setCopied('done'),
                  () => setCopied('failed'),
                );
              }}
            >
              {copied === 'done' ? t('once.copied') : t('once.copy')}
            </Button>
          </Space.Compact>
          {copied === 'failed' ? (
            <Typography.Text type="danger" role="alert">
              {t('once.copyFailed')}
            </Typography.Text>
          ) : null}
        </div>
      </Modal>
    );
  }

  const submit = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      // Not returned through a mutation hook: the answer stays in this component's state only.
      setIssued(await issueApiKey(actorId, trimmed, expiresAt));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : 'internal_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      destroyOnHidden
      title={t('issueTitle')}
      okText={t('issueSubmit')}
      cancelText={t('cancel')}
      okButtonProps={{ disabled: trimmed === '' || expiryPast || busy }}
      cancelButtonProps={{ disabled: busy }}
      // A request in flight cannot be abandoned: the key it returns would be lost (ADR-0365).
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onOk={() => void submit()}
    >
      <div className="flex flex-col gap-3">
        <Input
          aria-label={t('issueName')}
          placeholder={t('issueNamePlaceholder')}
          value={name}
          maxLength={MAX_NAME}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          type="datetime-local"
          aria-label={t('issueExpires')}
          value={expires}
          status={expiryPast ? 'error' : undefined}
          onChange={(e) => setExpires(e.target.value)}
        />
        <Typography.Text type={expiryPast ? 'danger' : 'secondary'}>
          {expiryPast ? t('issueExpiresPast') : t('issueExpiresHelp')}
        </Typography.Text>
        {failure ? <ErrorAlert error={new ApiError(0, failure)} /> : null}
      </div>
    </Modal>
  );
}
