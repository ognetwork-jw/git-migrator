'use client';

import { LoginOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Divider, Form, Input, Typography } from 'antd';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { type SignInOutcome, signInWithPassword, startEntraSignIn } from './client.ts';
import { hardNavigate } from './navigate.ts';

interface Credentials {
  readonly email: string;
  readonly password: string;
}

export interface SignInPanelProps {
  /** The address to return to afterwards (already validated by `safeNextPath`). */
  readonly next: string;
  /** Config `auth.testSignIn.enabled` (AUTH-012): shows the email and password form. */
  readonly testSignIn: boolean;
  /** For tests. */
  readonly navigate?: (url: string) => void;
  readonly fetchImpl?: typeof fetch;
}

/** The `/signin` page body (UI-036): the Entra button, and the test form when enabled. */
export function SignInPanel({ next, testSignIn, navigate, fetchImpl }: SignInPanelProps) {
  const t = useTranslations('auth.signin');
  const errors = useTranslations('auth.error');
  const [busy, setBusy] = useState<'entra' | 'password' | undefined>();
  const [failure, setFailure] = useState<SignInOutcome | undefined>();
  const go = navigate ?? hardNavigate;

  const settle = (outcome: SignInOutcome) => {
    if (outcome.kind === 'redirect') {
      go(outcome.url);
      return;
    }
    setFailure(outcome);
    setBusy(undefined);
  };

  const onEntra = async () => {
    setBusy('entra');
    setFailure(undefined);
    settle(await startEntraSignIn(next, fetchImpl));
  };

  const onPassword = async (values: Credentials) => {
    setBusy('password');
    setFailure(undefined);
    settle(await signInWithPassword(values, next, fetchImpl));
  };

  const failureText =
    failure?.kind === 'invalid'
      ? t('invalidCredentials')
      : failure?.kind === 'error'
        ? errors.has(failure.code) && failure.code !== 'title'
          ? errors(failure.code)
          : errors('unknown')
        : undefined;

  return (
    <Card className="w-full max-w-md">
      <Typography.Title level={1} className="text-2xl">
        {t('title')}
      </Typography.Title>
      <Typography.Paragraph type="secondary">{t('subtitle')}</Typography.Paragraph>
      {failureText === undefined ? null : (
        <Alert type="error" showIcon message={failureText} className="mb-4" role="alert" />
      )}
      <Button
        type="primary"
        size="large"
        block
        icon={<LoginOutlined aria-hidden />}
        loading={busy === 'entra'}
        disabled={busy === 'password'}
        onClick={() => void onEntra()}
      >
        {busy === 'entra' ? t('starting') : t('entra')}
      </Button>
      {testSignIn ? (
        <>
          <Divider>{t('testHeading')}</Divider>
          <Typography.Paragraph type="secondary">{t('testNotice')}</Typography.Paragraph>
          <Form<Credentials>
            layout="vertical"
            onFinish={(v) => void onPassword(v)}
            requiredMark={false}
          >
            <Form.Item
              name="email"
              label={t('email')}
              rules={[{ required: true, message: t('emailRequired') }]}
            >
              <Input type="email" autoComplete="username" disabled={busy !== undefined} />
            </Form.Item>
            <Form.Item
              name="password"
              label={t('password')}
              rules={[{ required: true, message: t('passwordRequired') }]}
            >
              <Input.Password autoComplete="current-password" disabled={busy !== undefined} />
            </Form.Item>
            <Button
              htmlType="submit"
              block
              loading={busy === 'password'}
              disabled={busy === 'entra'}
            >
              {t('submit')}
            </Button>
          </Form>
        </>
      ) : null}
    </Card>
  );
}
