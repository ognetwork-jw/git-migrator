'use client';

import { LoadingOutlined, SyncOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import { useTranslations } from 'next-intl';
import type { LiveMode } from '../live/index.ts';
import { useLiveMode } from './live-topics.tsx';

const ICONS: Record<LiveMode, React.ReactNode> = {
  connecting: <LoadingOutlined aria-hidden />,
  sse: <ThunderboltOutlined aria-hidden />,
  polling: <SyncOutlined aria-hidden />,
};

/**
 * The state of the live connection. Text and an icon carry the state, never the color alone
 * (UI-001), and the `polling` mode says why data may lag.
 */
export function LiveStatus() {
  const t = useTranslations('shell.live');
  const mode = useLiveMode();
  return (
    <span
      role="status"
      aria-live="polite"
      title={mode === 'polling' ? t('pollingHint') : undefined}
    >
      <span className="sr-only">{t('label')}: </span>
      <Tag
        icon={ICONS[mode]}
        color={mode === 'sse' ? 'success' : mode === 'polling' ? 'warning' : 'default'}
        data-live-mode={mode}
        className="me-0"
      >
        {t(mode)}
      </Tag>
    </span>
  );
}
