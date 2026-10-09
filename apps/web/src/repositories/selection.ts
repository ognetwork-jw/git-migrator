import { useCallback, useMemo, useState } from 'react';

/** What a bulk action (T-088) needs to know about a selected row. */
export interface SelectedRepository {
  readonly id: string;
  readonly readiness: string | null;
}

export interface RepositorySelection {
  readonly ids: readonly string[];
  readonly items: ReadonlyMap<string, SelectedRepository>;
  readonly count: number;
  /** Replaces the selection of the rows on the shown page and keeps every other page's rows. */
  readonly replaceOnPage: (
    pageIds: readonly string[],
    nextKeys: readonly string[],
    rows: readonly SelectedRepository[],
  ) => void;
  readonly clear: () => void;
}

/**
 * Row selection that survives page, sort and filter changes (UI-021): the selection is a map of
 * ids, not "the checked rows of the shown page". Bulk actions read `items`.
 */
export function useRepositorySelection(): RepositorySelection {
  const [items, setItems] = useState<ReadonlyMap<string, SelectedRepository>>(new Map());

  const replaceOnPage = useCallback(
    (
      pageIds: readonly string[],
      nextKeys: readonly string[],
      rows: readonly SelectedRepository[],
    ) => {
      setItems((current) => {
        const next = new Map(current);
        const keep = new Set(nextKeys);
        for (const id of pageIds) if (!keep.has(id)) next.delete(id);
        for (const row of rows) if (keep.has(row.id)) next.set(row.id, row);
        return next;
      });
    },
    [],
  );
  const clear = useCallback(() => setItems(new Map()), []);

  return useMemo(
    () => ({ ids: [...items.keys()], items, count: items.size, replaceOnPage, clear }),
    [items, replaceOnPage, clear],
  );
}
