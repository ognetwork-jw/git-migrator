'use client';

import { Checkbox, Select } from 'antd';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { RunLogRow } from './api.ts';

/** Height of one line and of the visible window, in pixels. Lines never wrap, so heights are fixed. */
export const ROW_HEIGHT = 22;
export const VIEW_HEIGHT = 384;
/** Lines rendered above and below the window, so a quick scroll does not show blanks. */
const OVERSCAN = 10;

export const LEVELS = ['all', 'info', 'warn', 'error'] as const;
export type LevelFilter = (typeof LEVELS)[number];

const RANK: Record<string, number> = {
  debug: 0,
  trace: 0,
  info: 1,
  warn: 2,
  warning: 2,
  error: 3,
  fatal: 3,
};
const MIN_RANK: Record<LevelFilter, number> = { all: 0, info: 1, warn: 2, error: 3 };

/** A level's severity rank; an unknown level reads as info so no line is hidden by accident. */
export const rankOf = (level: string): number => RANK[level.toLowerCase()] ?? 1;

/** The lines at or above the chosen level. */
export const filterLines = (
  lines: readonly RunLogRow[],
  level: LevelFilter,
): readonly RunLogRow[] =>
  level === 'all' ? lines : lines.filter((line) => rankOf(line.level) >= MIN_RANK[level]);

/** The index range to render for a scroll position (pure, so it is testable without layout). */
export function visibleRange(
  scrollTop: number,
  total: number,
  viewHeight = VIEW_HEIGHT,
): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN);
  return { start, end };
}

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
const timeOf = (ts: string): string => {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? '' : clock.format(date);
};

const LEVEL_CLASS: Record<number, string> = { 2: 'font-semibold', 3: 'font-bold' };

/**
 * The live log (UI-023): virtualized (only the lines in view are in the page), filtered by level,
 * and following the tail while "Follow" is on. Scrolling up turns following off; scrolling back to
 * the end turns it on again.
 */
export function LogViewer({
  lines,
  stepNames,
  truncated,
}: {
  readonly lines: readonly RunLogRow[];
  /** Step id to step key, so a line can say which step wrote it. */
  readonly stepNames: ReadonlyMap<string, string>;
  /** Older lines were dropped to keep the page light. */
  readonly truncated: boolean;
}) {
  const t = useTranslations('runDetail.log');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [follow, setFollow] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const shown = filterLines(lines, level);
  const total = shown.length;
  const { start, end } = visibleRange(scrollTop, total);

  // Follow the tail: keep the end in view when lines arrive.
  useEffect(() => {
    const el = box.current;
    if (!follow || el === null) return;
    el.scrollTop = Math.max(0, total * ROW_HEIGHT - VIEW_HEIGHT);
    setScrollTop(el.scrollTop);
  }, [follow, total]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Select<LevelFilter>
          aria-label={t('level')}
          className="min-w-40"
          value={level}
          onChange={setLevel}
          options={LEVELS.map((value) => ({ value, label: t(`levels.${value}`) }))}
        />
        <Checkbox checked={follow} onChange={(e) => setFollow(e.target.checked)}>
          {t('follow')}
        </Checkbox>
        <span className="text-sm opacity-70">
          {t('count', { shown: total, total: lines.length })}
        </span>
        {truncated ? <span className="text-sm opacity-70">{t('truncated')}</span> : null}
      </div>
      <div
        ref={box}
        role="log"
        aria-label={t('title')}
        // The window is a scroll container: a keyboard user scrolls it with the arrow keys.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region
        tabIndex={0}
        className="relative overflow-y-auto overflow-x-auto rounded border font-mono text-xs"
        style={{ height: VIEW_HEIGHT }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(el.scrollTop);
          const atEnd = el.scrollTop + VIEW_HEIGHT >= total * ROW_HEIGHT - ROW_HEIGHT;
          setFollow(atEnd);
        }}
      >
        {total === 0 ? <div className="p-2 opacity-70">{t('empty')}</div> : null}
        <div style={{ height: total * ROW_HEIGHT, position: 'relative', minWidth: 'max-content' }}>
          {shown.slice(start, end).map((line, offset) => (
            <div
              key={line.id}
              className="absolute left-0 right-0 flex gap-2 whitespace-pre px-2"
              style={{
                top: (start + offset) * ROW_HEIGHT,
                height: ROW_HEIGHT,
                lineHeight: `${ROW_HEIGHT}px`,
              }}
            >
              <span className="opacity-60">{timeOf(line.ts)}</span>
              <span className={`w-12 uppercase ${LEVEL_CLASS[rankOf(line.level)] ?? ''}`}>
                {line.level}
              </span>
              {line.stepId && stepNames.get(line.stepId) ? (
                <span className="opacity-60">{stepNames.get(line.stepId)}</span>
              ) : null}
              <span>{line.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
