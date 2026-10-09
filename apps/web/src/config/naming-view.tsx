'use client';

import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ApiError } from '../api/http.ts';
import { ErrorAlert, RouteSelect, useRouteChoice } from '../mapping/shared.tsx';
import {
  createNamingRule,
  deleteNamingRule,
  fetchNamingRules,
  fetchRouteConfigs,
  type NamingRuleRow,
  namingRulesKey,
  previewNaming,
  routeConfigKey,
  scopeLabels,
  searchNamespaces,
  searchRepositories,
  updateNamingRule,
} from './api.ts';
import {
  ALL_OPS,
  bodyKey,
  defaultPipeline,
  draftProblems,
  emptyStep,
  makeStep,
  type PipelineDraft,
  type PreviewItem,
  type PreviewState,
  type RuleBody,
  type RuleDraft,
  ruleBody,
  type SaveBlock,
  type Scope,
  type StepDraft,
  saveBlock,
} from './naming-draft.ts';

const MAX_ROWS_SHOWN = 50;

/** The finding code as a message key (`naming.invalid` is `naming_invalid`). */
const findingKey = (code: string) => code.replace(/[.-]/g, '_');

/**
 * UI-030: the naming rules of a Route. Route default (read-only: it is configuration, not a row),
 * namespace and repository rules, and the editor whose save waits for a preview (LIF-031).
 */
export function NamingRulesView() {
  const t = useTranslations('config.naming');
  const queryClient = useQueryClient();
  const [chosenRoute, setChosenRoute] = useState<string>();
  const [editing, setEditing] = useState<{ rule?: NamingRuleRow }>();
  const { routes, routeId, query: routesQuery } = useRouteChoice(chosenRoute);
  const route = routes.find((r) => r.id === routeId);

  const rules = useQuery({
    queryKey: namingRulesKey(routeId ?? ''),
    enabled: routeId !== undefined,
    queryFn: () => fetchNamingRules(routeId as string),
  });
  const labels = useQuery({
    queryKey: ['config', 'scope-labels', routeId, rules.data],
    enabled: rules.data !== undefined,
    queryFn: () => scopeLabels(rules.data ?? []),
  });
  const configs = useQuery({ queryKey: routeConfigKey, queryFn: fetchRouteConfigs });
  const defaultNaming = configs.data?.find((c) => c.id === routeId)?.defaults.naming;

  const remove = useMutation({
    mutationFn: (id: string) => deleteNamingRule(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config', 'naming-rules'] }),
  });

  if (routesQuery.isError) return <ErrorAlert error={routesQuery.error} />;
  if (routesQuery.isSuccess && routeId === undefined) {
    return <Typography.Paragraph type="secondary">{t('noRoutes')}</Typography.Paragraph>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Space wrap>
        <RouteSelect routes={routes} value={routeId} onChange={setChosenRoute} />
        <Button
          type="primary"
          icon={<PlusOutlined aria-hidden />}
          disabled={routeId === undefined}
          onClick={() => setEditing({})}
        >
          {t('rules.new')}
        </Button>
      </Space>

      <section aria-labelledby="naming-default" className="flex flex-col gap-2">
        <Typography.Title id="naming-default" level={2} className="!text-lg">
          {t('routeDefault.title')}
        </Typography.Title>
        <Typography.Paragraph type="secondary">{t('routeDefault.body')}</Typography.Paragraph>
        {defaultNaming ? (
          <div className="flex flex-col gap-1">
            <Typography.Text>
              {t('routeDefault.template', { template: defaultNaming.template })}
            </Typography.Text>
            <PipelineSummary steps={defaultNaming.steps} />
          </div>
        ) : (
          <Typography.Text type="secondary">{t('routeDefault.none')}</Typography.Text>
        )}
      </section>

      <section aria-labelledby="naming-rules" className="flex flex-col gap-2">
        <Typography.Title id="naming-rules" level={2} className="!text-lg">
          {t('rules.title')}
        </Typography.Title>
        {rules.isError ? <ErrorAlert error={rules.error} /> : null}
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        <Table<NamingRuleRow>
          rowKey="id"
          size="middle"
          loading={rules.isLoading || rules.isFetching}
          dataSource={rules.data ?? []}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: t('rules.empty') }}
          columns={[
            {
              title: t('rules.column.scope'),
              key: 'scope',
              render: (_: unknown, r) => <Tag>{t(`rules.scope.${r.scope}`)}</Tag>,
            },
            {
              title: t('rules.column.target'),
              key: 'target',
              render: (_: unknown, r) => labels.data?.get(r.scopeRef) ?? r.scopeRef,
            },
            {
              title: t('rules.column.rule'),
              key: 'rule',
              render: (_: unknown, r) =>
                r.override !== null ? (
                  <Typography.Text>
                    {t('rules.summary.override', { name: r.override })}
                  </Typography.Text>
                ) : (
                  <PipelineSummary steps={r.pipeline.steps} template={r.pipeline.template} />
                ),
            },
            {
              title: t('rules.column.actions'),
              key: 'actions',
              render: (_: unknown, r) => (
                <Space wrap size="small">
                  <Button
                    size="small"
                    icon={<EditOutlined aria-hidden />}
                    onClick={() => setEditing({ rule: r })}
                  >
                    {t('rules.edit')}
                  </Button>
                  <Popconfirm
                    title={t('rules.deleteTitle')}
                    description={
                      <div className="flex max-w-xs flex-col gap-1">
                        <span>{t('rules.deleteBody')}</span>
                        <Typography.Text type="warning">{t('rules.deleteWarning')}</Typography.Text>
                      </div>
                    }
                    okText={t('rules.deleteConfirm')}
                    cancelText={t('cancel')}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => remove.mutate(r.id)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined aria-hidden />}>
                      {t('rules.delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </section>

      {editing && routeId !== undefined ? (
        <NamingRuleModal
          key={editing.rule?.id ?? 'new'}
          routeId={routeId}
          endpointId={route?.sourceEndpointId ?? ''}
          rule={editing.rule}
          existing={rules.data ?? []}
          labels={labels.data ?? new Map()}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

function PipelineSummary({
  steps,
  template,
}: {
  readonly steps: readonly { var: string; op: string }[];
  readonly template?: string;
}) {
  const t = useTranslations('config.naming');
  return (
    <div className="flex flex-col">
      {template !== undefined ? (
        <Typography.Text code>{t('rules.summary.pipeline', { template })}</Typography.Text>
      ) : null}
      <Typography.Text type="secondary" className="text-xs">
        {steps.map((s) => `${s.var}: ${s.op}`).join(' · ')}
      </Typography.Text>
    </div>
  );
}

const initialDraft = (rule: NamingRuleRow | undefined): RuleDraft => {
  if (!rule) {
    return {
      scope: 'namespace',
      scopeRef: '',
      mode: 'pipeline',
      pipeline: defaultPipeline(),
      override: '',
    };
  }
  const steps: StepDraft[] = rule.pipeline.steps.map((s) =>
    makeStep({
      var: s.var,
      op: s.op,
      arg: 'arg' in s ? s.arg : null,
      pattern: 'pattern' in s ? s.pattern : '',
      with: 'with' in s ? s.with : '',
    }),
  );
  return {
    scope: rule.scope,
    scopeRef: rule.scopeRef,
    mode: rule.override !== null ? 'override' : 'pipeline',
    pipeline: { steps, template: rule.pipeline.template },
    override: rule.override ?? '',
  };
};

/** The editor. Save needs a preview of the exact body and, with collisions, a confirmation. */
function NamingRuleModal({
  routeId,
  endpointId,
  rule,
  existing,
  labels,
  onClose,
}: {
  readonly routeId: string;
  readonly endpointId: string;
  readonly rule: NamingRuleRow | undefined;
  readonly existing: readonly NamingRuleRow[];
  readonly labels: ReadonlyMap<string, string>;
  readonly onClose: () => void;
}) {
  const t = useTranslations('config.naming');
  const problemText = useTranslations('problem');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RuleDraft>(() => initialDraft(rule));
  const [preview, setPreview] = useState<PreviewState>();
  const [confirmed, setConfirmed] = useState(false);
  const [scopeSearch, setScopeSearch] = useState('');

  const problems = draftProblems(draft);
  const scopeTaken =
    rule === undefined &&
    existing.some((r) => r.scope === draft.scope && r.scopeRef === draft.scopeRef);
  const valid = problems.length === 0 && !scopeTaken;
  const body: RuleBody | undefined = problems.length === 0 ? ruleBody(draft) : undefined;
  const key = body ? bodyKey(body) : '';
  const block: SaveBlock | undefined = saveBlock({ valid, key, preview, confirmed });

  // A collision acceptance belongs to the exact rule that was previewed: any edit withdraws it, so
  // editing and reverting asks again (UI-030).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the trigger, not a value read
  useEffect(() => {
    setConfirmed(false);
  }, [key]);

  const runPreview = useMutation({
    mutationFn: async (target: RuleBody) => ({
      target,
      result: await previewNaming(routeId, target),
    }),
    onSuccess: ({ target, result }) => {
      setPreview({ key: bodyKey(target), body: target, result });
      setConfirmed(false);
    },
    onError: (error, target) => {
      setPreview({
        key: bodyKey(target),
        body: target,
        failure: error instanceof ApiError ? error.code : 'internal_error',
      });
      setConfirmed(false);
    },
  });

  const loadMore = useMutation({
    mutationFn: (cursor: string) => previewNaming(routeId, preview?.body as RuleBody, cursor),
    onSuccess: (more) =>
      setPreview((prev) =>
        prev?.result
          ? {
              ...prev,
              result: {
                ...prev.result,
                items: [...prev.result.items, ...more.items],
                nextCursor: more.nextCursor,
              },
            }
          : prev,
      ),
  });

  const save = useMutation({
    mutationFn: () => {
      if (body === undefined || block !== undefined) throw new Error('save is blocked');
      return rule ? updateNamingRule(rule.id, body) : createNamingRule(routeId, body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['config', 'naming-rules'] });
      onClose();
    },
  });

  const scopeOptions = useQuery({
    queryKey: ['config', 'scope-search', endpointId, draft.scope, scopeSearch],
    enabled: rule === undefined && endpointId !== '',
    queryFn: () =>
      draft.scope === 'namespace'
        ? searchNamespaces(endpointId, scopeSearch)
        : searchRepositories(endpointId, scopeSearch),
  });

  const updateDraft = (patch: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const updateStep = (index: number, patch: Partial<StepDraft>) =>
    setDraft((d) => ({
      ...d,
      pipeline: {
        ...d.pipeline,
        steps: d.pipeline.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
      },
    }));

  const items: readonly PreviewItem[] = preview?.result?.items ?? [];
  const sourceOf = new Map(items.map((i) => [i.migrationId, i.sourcePath]));
  const failure = preview?.failure;
  const previewCurrent = preview !== undefined && preview.key === key;

  return (
    <Modal
      open
      destroyOnHidden
      width={880}
      title={rule ? t('modal.editTitle') : t('modal.newTitle')}
      okText={t('save')}
      cancelText={t('cancel')}
      okButtonProps={{ disabled: block !== undefined || save.isPending }}
      onCancel={onClose}
      onOk={() => save.mutate()}
    >
      <div className="flex flex-col gap-4">
        {rule ? (
          <Typography.Paragraph>
            {t('modal.scopeFixed', {
              scope: t(`rules.scope.${rule.scope}`),
              target: labels.get(rule.scopeRef) ?? rule.scopeRef,
            })}
          </Typography.Paragraph>
        ) : (
          <Space wrap>
            <Select<Scope>
              aria-label={t('modal.scope')}
              className="w-44"
              value={draft.scope}
              onChange={(scope) => updateDraft({ scope, scopeRef: '', mode: 'pipeline' })}
              options={[
                { value: 'namespace', label: t('rules.scope.namespace') },
                { value: 'repository', label: t('rules.scope.repository') },
              ]}
            />
            <Select<string>
              showSearch
              aria-label={t('modal.scopeRef')}
              placeholder={t('modal.scopeRefPlaceholder')}
              className="min-w-72"
              value={draft.scopeRef || undefined}
              filterOption={false}
              onSearch={setScopeSearch}
              onChange={(scopeRef) => updateDraft({ scopeRef })}
              loading={scopeOptions.isFetching}
              notFoundContent={t('modal.scopeNone')}
              options={(scopeOptions.data ?? []).map((o) => ({ value: o.id, label: o.label }))}
            />
          </Space>
        )}
        {scopeTaken ? <Alert type="warning" showIcon title={t('modal.scopeTaken')} /> : null}

        <Radio.Group
          aria-label={t('modal.modeLabel')}
          value={draft.mode}
          onChange={(e) => updateDraft({ mode: e.target.value as RuleDraft['mode'] })}
          options={[
            { value: 'pipeline', label: t('modal.mode.pipeline') },
            {
              value: 'override',
              label: t('modal.mode.override'),
              disabled: draft.scope !== 'repository',
            },
          ]}
          optionType="button"
        />

        {draft.mode === 'override' ? (
          <div className="flex flex-col gap-1">
            <Input
              aria-label={t('override.label')}
              placeholder={t('override.placeholder')}
              value={draft.override}
              maxLength={256}
              onChange={(e) => updateDraft({ override: e.target.value })}
            />
            <Typography.Text type="secondary">{t('override.help')}</Typography.Text>
          </div>
        ) : (
          <PipelineEditor
            pipeline={draft.pipeline}
            onTemplate={(template) =>
              setDraft((d) => ({ ...d, pipeline: { ...d.pipeline, template } }))
            }
            onStep={updateStep}
            onAdd={() =>
              setDraft((d) => ({
                ...d,
                pipeline: { ...d.pipeline, steps: [...d.pipeline.steps, emptyStep()] },
              }))
            }
            onRemove={(index) =>
              setDraft((d) => ({
                ...d,
                pipeline: {
                  ...d.pipeline,
                  steps: d.pipeline.steps.filter((_, i) => i !== index),
                },
              }))
            }
          />
        )}

        {problems.length > 0 ? (
          <ul className="list-disc pl-5 text-sm">
            {problems.map((p) => (
              <li key={p}>{t(`problem.${p}`)}</li>
            ))}
          </ul>
        ) : null}

        <section aria-labelledby="naming-preview" className="flex flex-col gap-2">
          <Space wrap>
            <Typography.Title id="naming-preview" level={3} className="!m-0 !text-base">
              {t('preview.title')}
            </Typography.Title>
            <Button
              disabled={body === undefined || runPreview.isPending}
              loading={runPreview.isPending}
              onClick={() => body && runPreview.mutate(body)}
            >
              {t('preview.run')}
            </Button>
          </Space>
          {preview && !previewCurrent ? (
            <Alert type="info" showIcon title={t('preview.stale')} />
          ) : null}
          {failure ? (
            <Alert
              type="error"
              showIcon
              role="alert"
              title={t('preview.failed', {
                reason: problemText.has(failure)
                  ? problemText(failure)
                  : problemText('internal_error'),
              })}
            />
          ) : null}
          {preview?.result && previewCurrent ? (
            <PreviewResults
              result={preview.result}
              sourceOf={sourceOf}
              items={items}
              onMore={() => {
                if (preview.result?.nextCursor) loadMore.mutate(preview.result.nextCursor);
              }}
              loadingMore={loadMore.isPending}
              confirmed={confirmed}
              onConfirm={setConfirmed}
            />
          ) : null}
          {block !== undefined && block !== 'invalid' ? (
            <Typography.Text type="secondary">{t(`blocked.${block}`)}</Typography.Text>
          ) : null}
          {save.isError ? <ErrorAlert error={save.error} /> : null}
        </section>
      </div>
    </Modal>
  );
}

function PipelineEditor({
  pipeline,
  onTemplate,
  onStep,
  onAdd,
  onRemove,
}: {
  readonly pipeline: PipelineDraft;
  readonly onTemplate: (template: string) => void;
  readonly onStep: (index: number, patch: Partial<StepDraft>) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}) {
  const t = useTranslations('config.naming');
  return (
    <section aria-labelledby="naming-pipeline" className="flex flex-col gap-3">
      <Typography.Title id="naming-pipeline" level={3} className="!m-0 !text-base">
        {t('pipeline.title')}
      </Typography.Title>
      {pipeline.steps.map((step, index) => (
        <Space key={step.uid} wrap align="start">
          <Typography.Text type="secondary" className="pt-1">
            {t('pipeline.stepNumber', { number: index + 1 })}
          </Typography.Text>
          <Input
            aria-label={t('pipeline.step.var')}
            className="w-36"
            value={step.var}
            maxLength={64}
            onChange={(e) => onStep(index, { var: e.target.value })}
          />
          <Select<string>
            aria-label={t('pipeline.step.op')}
            className="w-40"
            value={step.op}
            onChange={(op) => onStep(index, { op })}
            options={ALL_OPS.map((op) => ({ value: op, label: t(`op.${op}`) }))}
          />
          {step.op === 'truncate' ? (
            <InputNumber
              aria-label={t('pipeline.step.arg')}
              min={1}
              precision={0}
              value={step.arg}
              onChange={(arg) => onStep(index, { arg: typeof arg === 'number' ? arg : null })}
            />
          ) : null}
          {step.op === 'replace' ? (
            <>
              <Input
                aria-label={t('pipeline.step.pattern')}
                placeholder={t('pipeline.step.pattern')}
                className="w-48"
                value={step.pattern}
                maxLength={400}
                onChange={(e) => onStep(index, { pattern: e.target.value })}
              />
              <Input
                aria-label={t('pipeline.step.with')}
                placeholder={t('pipeline.step.with')}
                className="w-40"
                value={step.with}
                maxLength={400}
                onChange={(e) => onStep(index, { with: e.target.value })}
              />
            </>
          ) : null}
          <Button
            size="small"
            danger
            aria-label={t('pipeline.step.remove', { number: index + 1 })}
            icon={<DeleteOutlined aria-hidden />}
            onClick={() => onRemove(index)}
          />
        </Space>
      ))}
      <div>
        <Button size="small" icon={<PlusOutlined aria-hidden />} onClick={onAdd}>
          {t('pipeline.addStep')}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <Input
          aria-label={t('pipeline.template')}
          value={pipeline.template}
          maxLength={256}
          onChange={(e) => onTemplate(e.target.value)}
        />
        <Typography.Text type="secondary">
          {t('pipeline.templateHelp', { example: '{namespace}-{repository}' })}
        </Typography.Text>
      </div>
    </section>
  );
}

function PreviewResults({
  result,
  sourceOf,
  items,
  onMore,
  loadingMore,
  confirmed,
  onConfirm,
}: {
  readonly result: NonNullable<PreviewState['result']>;
  readonly sourceOf: ReadonlyMap<string, string>;
  readonly items: readonly PreviewItem[];
  readonly onMore: () => void;
  readonly loadingMore: boolean;
  readonly confirmed: boolean;
  readonly onConfirm: (value: boolean) => void;
}) {
  const t = useTranslations('config.naming');
  const { summary, collisions } = result;
  return (
    <div className="flex flex-col gap-3">
      <Typography.Text>
        {t('preview.summary', {
          affected: summary.affected,
          changed: summary.changed,
          invalid: summary.invalid,
          colliding: summary.colliding,
        })}
      </Typography.Text>
      {collisions.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          title={t('preview.collisionTitle', { count: collisions.length })}
          description={
            <div className="flex flex-col gap-2">
              <Typography.Text>{t('preview.collisionBody')}</Typography.Text>
              <ul className="list-disc pl-5">
                {collisions.map((group) => (
                  <li key={group.key}>
                    <Typography.Text code>{group.key}</Typography.Text>{' '}
                    {group.members.map((id) => sourceOf.get(id) ?? id).join(', ')}
                  </li>
                ))}
              </ul>
              <Checkbox checked={confirmed} onChange={(e) => onConfirm(e.target.checked)}>
                {t('confirm.collisions')}
              </Checkbox>
            </div>
          }
        />
      ) : null}
      {items.length === 0 ? (
        <Typography.Text type="secondary">{t('preview.empty')}</Typography.Text>
      ) : (
        <Table<PreviewItem>
          rowKey="migrationId"
          size="small"
          pagination={false}
          scroll={{ x: 'max-content' }}
          dataSource={items.slice(0, MAX_ROWS_SHOWN)}
          columns={[
            {
              title: t('preview.column.source'),
              key: 'source',
              render: (_: unknown, i) => i.sourcePath,
            },
            {
              title: t('preview.column.current'),
              key: 'current',
              render: (_: unknown, i) => i.currentName ?? '',
            },
            {
              title: t('preview.column.planned'),
              key: 'planned',
              render: (_: unknown, i) => i.plannedName ?? '',
            },
            {
              title: t('preview.column.changed'),
              key: 'changed',
              render: (_: unknown, i) => (
                <Tag>{i.changed ? t('preview.changed') : t('preview.unchanged')}</Tag>
              ),
            },
            {
              title: t('preview.column.findings'),
              key: 'findings',
              render: (_: unknown, i) =>
                i.findings.map((f) => (
                  <Tag key={f.code} color={f.severity === 'blocker' ? 'error' : 'default'}>
                    {t.has(`finding.${findingKey(f.code)}`)
                      ? t(`finding.${findingKey(f.code)}`)
                      : f.code}
                  </Tag>
                )),
            },
          ]}
        />
      )}
      {result.nextCursor !== null || items.length > MAX_ROWS_SHOWN ? (
        <Typography.Text type="secondary">
          {t('preview.shown', {
            shown: Math.min(items.length, MAX_ROWS_SHOWN),
            total: summary.affected,
          })}
        </Typography.Text>
      ) : null}
      {result.nextCursor !== null ? (
        <Button onClick={onMore} loading={loadingMore} className="self-start">
          {t('preview.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
