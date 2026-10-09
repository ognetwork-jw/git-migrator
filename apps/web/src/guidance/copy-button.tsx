'use client';

import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

/** How long the "Copied" confirmation stays. */
const CONFIRM_MS = 2000;

/** Writes to the clipboard; false when the browser refuses or has no clipboard API. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A copy-to-clipboard button (UI-040). `label` names what is copied for a screen reader. The result
 * is announced in a polite live region, and a refused copy says so instead of pretending.
 */
export function CopyButton({ value, label }: { readonly value: string; readonly label: string }) {
  const t = useTranslations('copy');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    setState((await writeClipboard(value)) ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), CONFIRM_MS);
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Button
        size="small"
        type="default"
        icon={state === 'copied' ? <CheckOutlined /> : <CopyOutlined />}
        aria-label={t('label', { what: label })}
        onClick={copy}
      >
        {t('button')}
      </Button>
      <span role="status" aria-live="polite" className="text-xs">
        {state === 'copied' ? t('copied') : state === 'failed' ? t('failed') : ''}
      </span>
    </span>
  );
}
