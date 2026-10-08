'use client';

import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Drawer, Input, Space, Table, Tag, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { ApiError } from '../api/http.ts';
import { type CsvReport, type CsvRowReport, importCsv } from './api.ts';
import { ErrorAlert } from './shared.tsx';

/** The most bytes read from a chosen file; the API refuses bodies above 1 MiB anyway. */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * UI-027: the CSV import Drawer. "Check file" is a dry run that reports every row; "Apply" is
 * offered only after a dry run of the same text came back without errors, and the API validates
 * again before it writes anything (AUTH-050 step 3).
 */
export function CsvImportDrawer({
  routeId,
  open,
  onClose,
  onApplied,
}: {
  readonly routeId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onApplied: () => void;
}) {
  const t = useTranslations('mapping.csv');
  const [text, setText] = useState('');
  const [checked, setChecked] = useState<{ text: string; report: CsvReport }>();
  const [applied, setApplied] = useState<CsvReport>();
  const [tooLarge, setTooLarge] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const check = useMutation({
    mutationFn: (body: string) => importCsv(routeId, body, true),
    onSuccess: (report, body) => {
      setChecked({ text: body, report });
      setApplied(undefined);
    },
  });
  const apply = useMutation({
    mutationFn: (body: string) => importCsv(routeId, body, false),
    onSuccess: (report) => {
      setApplied(report);
      setChecked(undefined);
      onApplied();
    },
    // A 422 means the file no longer validates: show it as a fresh check.
    onError: () => setChecked(undefined),
  });

  const report = applied ?? checked?.report;
  const canApply = checked?.report.ok === true && checked.text === text && text !== '';

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setTooLarge(true);
      return;
    }
    setTooLarge(false);
    setText(await file.text());
    setChecked(undefined);
    setApplied(undefined);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('title')}
      size={720}
      destroyOnHidden
      closable={{ 'aria-label': t('close') }}
    >
      <div className="flex flex-col gap-4">
        <Typography.Paragraph>{t('help')}</Typography.Paragraph>
        <Typography.Text code>{t('format')}</Typography.Text>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          aria-label={t('file')}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        {tooLarge ? <Alert type="error" showIcon title={t('tooLarge')} /> : null}
        <Input.TextArea
          aria-label={t('text')}
          placeholder={t('textPlaceholder')}
          rows={8}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setChecked(undefined);
            setApplied(undefined);
          }}
        />
        <Space>
          <Button
            onClick={() => check.mutate(text)}
            loading={check.isPending}
            disabled={text.trim() === ''}
          >
            {t('check')}
          </Button>
          <Button
            type="primary"
            onClick={() => apply.mutate(text)}
            loading={apply.isPending}
            disabled={!canApply}
          >
            {t('apply')}
          </Button>
        </Space>
        {check.isError ? <ErrorAlert error={check.error} /> : null}
        {apply.isError ? <ApplyFailed error={apply.error} /> : null}
        {report ? <Report report={report} /> : null}
      </div>
    </Drawer>
  );
}

function ApplyFailed({ error }: { readonly error: unknown }) {
  const t = useTranslations('mapping.csv');
  if (error instanceof ApiError && error.code === 'validation_failed') {
    return <Alert type="error" showIcon role="alert" title={t('rejected')} />;
  }
  return <ErrorAlert error={error} />;
}

function Report({ report }: { readonly report: CsvReport }) {
  const t = useTranslations('mapping.csv');
  const errorText = (code: string) => (t.has(`error.${code}`) ? t(`error.${code}`) : code);
  const headline = report.dryRun
    ? report.ok
      ? t('checkedOk', { count: report.summary.total })
      : t('checkedErrors', { count: report.summary.invalid + report.fileErrors.length })
    : t('applied', {
        mapped: report.summary.mapped,
        invited: report.summary.invited,
        excluded: report.summary.excluded,
        unchanged: report.summary.unchanged,
        replaced: report.summary.replaced,
      });
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <Alert type={report.ok ? 'success' : 'error'} showIcon title={headline} />
      {report.fileErrors.map((code) => (
        <Alert key={code} type="error" showIcon title={errorText(code)} />
      ))}
      {report.rows.length > 0 ? (
        <Table<CsvRowReport>
          rowKey="line"
          size="small"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          dataSource={[...report.rows]}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: t('column.line'), dataIndex: 'line' },
            { title: t('column.source'), dataIndex: 'source' },
            { title: t('column.target'), dataIndex: 'target' },
            {
              title: t('column.action'),
              dataIndex: 'action',
              render: (action: string) =>
                t.has(`action.${action}`) ? t(`action.${action}`) : action,
            },
            {
              title: t('column.result'),
              key: 'result',
              render: (_: unknown, row) =>
                row.ok ? (
                  <Tag color="success">{t(`outcome.${row.outcome ?? 'unchanged'}`)}</Tag>
                ) : (
                  <ul className="m-0 list-none p-0">
                    {row.errors.map((code) => (
                      <li key={code}>
                        <Tag color="error">{errorText(code)}</Tag>
                      </li>
                    ))}
                  </ul>
                ),
            },
          ]}
        />
      ) : null}
    </div>
  );
}
