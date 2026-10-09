'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { entriesOf, isContainer, type JsonMark, markEntry, scalarText } from './json-diff.ts';

/** Entries of one object shown before the rest hides behind a control (large Facets stay usable). */
const MAX_ENTRIES = 100;
/** Levels expanded when the tree first shows. */
const OPEN_DEPTH = 1;

interface NodeProps {
  readonly name: string | number;
  readonly value: unknown;
  /** The counterpart tree at the same place; `hasOther` is false when there is none to compare. */
  readonly other: unknown;
  readonly hasOther: boolean;
  readonly mark: JsonMark;
  readonly depth: number;
}

function MarkText({ mark }: { readonly mark: JsonMark }) {
  const t = useTranslations('migrationDetail.facets.mark');
  if (mark === 'same') return null;
  return <span className="ms-2 rounded border px-1 text-xs">{t(mark)}</span>;
}

function TreeNode({ name, value, other, hasOther, mark, depth }: NodeProps) {
  const t = useTranslations('migrationDetail.facets');
  const [open, setOpen] = useState(depth < OPEN_DEPTH);
  const [all, setAll] = useState(false);
  if (!isContainer(value)) {
    return (
      <li className="list-none">
        <span className="font-mono text-xs">
          {name}: {scalarText(value)}
        </span>
        <MarkText mark={mark} />
      </li>
    );
  }
  const entries = entriesOf(value);
  const shown = all ? entries : entries.slice(0, MAX_ENTRIES);
  const summary = Array.isArray(value)
    ? t('tree.items', { count: entries.length })
    : t('tree.keys', { count: entries.length });
  return (
    <li className="list-none">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="cursor-pointer border-0 bg-transparent p-0 font-mono text-xs"
      >
        {open ? '▾' : '▸'} {name} <span className="opacity-70">({summary})</span>
      </button>
      <MarkText mark={mark} />
      {open ? (
        <ul className="m-0 ps-4">
          {shown.map(([key, child]) => (
            <TreeNode
              key={key}
              name={key}
              value={child}
              other={
                Array.isArray(other)
                  ? other[key as number]
                  : (other as Record<string, unknown> | null | undefined)?.[String(key)]
              }
              hasOther={hasOther}
              mark={markEntry(child, other, key, hasOther)}
              depth={depth + 1}
            />
          ))}
          {entries.length > shown.length ? (
            <li className="list-none">
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 text-xs underline"
                onClick={() => setAll(true)}
              >
                {t('tree.more', { count: entries.length - shown.length })}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * A collapsible JSON tree (UI-022). Entries that differ from the same place in `compareTo` carry a
 * text marker ("changed", "only here"); the marker is words, not only color (UI-001).
 */
export function JsonTree({
  value,
  compareTo,
  label,
}: {
  readonly value: unknown;
  readonly compareTo: unknown;
  readonly label: string;
}) {
  const t = useTranslations('migrationDetail.facets');
  if (value === null || value === undefined) {
    return <p className="m-0 text-sm opacity-70">{t('tree.none')}</p>;
  }
  const hasOther = compareTo !== null && compareTo !== undefined;
  return (
    <ul aria-label={label} className="m-0 overflow-x-auto p-0">
      <TreeNode
        name={label}
        value={value}
        other={compareTo}
        hasOther={hasOther}
        mark="same"
        depth={0}
      />
    </ul>
  );
}
