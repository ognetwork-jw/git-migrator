import { type CsvAction, type CsvErrorCode, neutralizeCell, type ParsedCsvRow } from './csv.ts';

export interface SourceIdentityInfo {
  readonly id: string;
  readonly providerId: string;
  readonly login: string | null;
  readonly email: string | null;
  readonly emailSource: string | null;
}

export interface TargetIdentityInfo {
  readonly id: string;
  readonly login: string | null;
  readonly email: string | null;
}

export interface ExistingMappingInfo {
  readonly sourceIdentityId: string;
  readonly status: string;
  readonly targetIdentityId: string | null;
}

export type RowOutcome = 'mapped' | 'invited' | 'excluded' | 'unchanged' | 'replaces_decision';

/** What apply needs for one valid row. Not part of the API response. */
export interface RowPlan {
  readonly action: CsvAction;
  readonly sourceIdentityId: string;
  readonly targetIdentityId: string | null;
  /** `invite` only: the email to record on the source Identity, when it must change. */
  readonly setEmail: string | null;
}

/** One row after resolution. `source` and `target` are neutralized for display and export. */
export interface ResolvedRow {
  readonly line: number;
  readonly source: string;
  readonly target: string;
  readonly action: string;
  readonly ok: boolean;
  readonly errors: CsvErrorCode[];
  readonly outcome: RowOutcome | null;
  readonly plan: RowPlan | null;
}

const ACTIONS: readonly CsvAction[] = ['map', 'invite', 'exclude'];

const lower = (value: string | null): string => (value ?? '').toLowerCase();

function groupBy<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null || k === '') continue;
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

interface Draft {
  row: ParsedCsvRow;
  errors: CsvErrorCode[];
  source?: SourceIdentityInfo;
  target?: TargetIdentityInfo;
}

/**
 * Resolves parsed rows against the Route's Identities and Mappings without writing anything
 * (AUTH-050 step 3). A source is a Provider account id or a login; a target is a login or an
 * email. A cell that matches several Identities is an error, never a guess. After resolution no
 * two rows name the same source, and no target ends up confirmed for two sources.
 */
export function resolveRows(
  rows: readonly ParsedCsvRow[],
  sources: readonly SourceIdentityInfo[],
  targets: readonly TargetIdentityInfo[],
  mappings: readonly ExistingMappingInfo[],
): ResolvedRow[] {
  const sourceByProvider = new Map(sources.map((s) => [s.providerId, s]));
  const sourceByLogin = groupBy(sources, (s) => (s.login === null ? null : lower(s.login)));
  const targetByLogin = groupBy(targets, (t) => (t.login === null ? null : lower(t.login)));
  const targetByEmail = groupBy(targets, (t) => (t.email === null ? null : lower(t.email)));
  const mappingBySource = new Map(mappings.map((m) => [m.sourceIdentityId, m]));

  const drafts: Draft[] = rows.map((row) => {
    const errors: CsvErrorCode[] = [...row.errors];
    const draft: Draft = { row, errors };
    const fail = (code: CsvErrorCode) => {
      if (!errors.includes(code)) errors.push(code);
    };
    if (row.source !== '' && !errors.includes('column_count')) {
      const byId = sourceByProvider.get(row.source);
      const byLogin = sourceByLogin.get(row.source.toLowerCase()) ?? [];
      if (byId) {
        // An account id that is also somebody else's login is ambiguous, never a guess.
        if (byLogin.some((s) => s.id !== byId.id)) fail('source_ambiguous');
        else draft.source = byId;
      } else {
        const found = byLogin;
        if (found.length === 1) draft.source = found[0] as SourceIdentityInfo;
        else fail(found.length === 0 ? 'source_not_found' : 'source_ambiguous');
      }
    }
    if (row.action === 'map' && row.target !== '' && !errors.includes('formula_prefix')) {
      const key = row.target.toLowerCase();
      const found = (row.target.includes('@') ? targetByEmail : targetByLogin).get(key) ?? [];
      if (found.length === 1) draft.target = found[0] as TargetIdentityInfo;
      else fail(found.length === 0 ? 'target_not_found' : 'target_ambiguous');
    }
    if (row.action === 'invite' && draft.source) {
      // AUTH-050 step 2: decisions are never overwritten. Unmap first.
      const status = mappingBySource.get(draft.source.id)?.status;
      if (status === 'confirmed' || status === 'excluded') fail('already_decided');
    }
    if ((row.action === 'map' || row.action === 'exclude') && draft.source) {
      // An invitation is out for this person: revoke it first (AUTH-060), as `unmap` requires.
      if (mappingBySource.get(draft.source.id)?.status === 'pending_invite') fail('invite_pending');
    }
    if (row.action === 'invite' && draft.source && errors.length === 0) {
      const { email, emailSource } = draft.source;
      if (email !== null && emailSource !== 'csv' && lower(email) !== row.target.toLowerCase()) {
        fail('email_conflict');
      }
    }
    return draft;
  });

  // The same source twice: the first row wins, later ones are errors.
  const seen = new Set<string>();
  for (const d of drafts) {
    if (!d.source) continue;
    if (seen.has(d.source.id)) {
      if (!d.errors.includes('duplicate_source')) d.errors.push('duplicate_source');
    } else {
      seen.add(d.source.id);
    }
  }

  // Targets confirmed after the import: today's confirmations of sources the file does not touch,
  // plus the file's own `map` rows.
  const touched = new Set(drafts.flatMap((d) => (d.source ? [d.source.id] : [])));
  const holder = new Map<string, string>();
  for (const m of mappings) {
    if (m.status === 'confirmed' && m.targetIdentityId && !touched.has(m.sourceIdentityId)) {
      holder.set(m.targetIdentityId, m.sourceIdentityId);
    }
  }
  for (const d of drafts) {
    if (d.row.action !== 'map' || !d.source || !d.target || d.errors.length > 0) continue;
    const owner = holder.get(d.target.id);
    if (owner !== undefined && owner !== d.source.id) d.errors.push('target_taken');
    else holder.set(d.target.id, d.source.id);
  }

  return drafts.map((d): ResolvedRow => {
    const { row, errors } = d;
    const base = {
      line: row.line,
      source: neutralizeCell(row.source),
      target: neutralizeCell(row.target),
      // Only a known action is echoed; anything else could carry a spreadsheet formula.
      action: ACTIONS.includes(row.action as CsvAction) ? row.action : 'invalid',
    };
    if (errors.length > 0 || !d.source) {
      return { ...base, ok: false, errors, outcome: null, plan: null };
    }
    const existing = mappingBySource.get(d.source.id);
    const action = row.action as CsvAction;
    const plan: RowPlan = {
      action,
      sourceIdentityId: d.source.id,
      targetIdentityId: d.target?.id ?? null,
      setEmail:
        action === 'invite' && lower(d.source.email) !== row.target.toLowerCase()
          ? row.target
          : null,
    };
    let outcome: RowOutcome;
    if (action === 'map') {
      outcome =
        existing?.status === 'confirmed' && existing.targetIdentityId === d.target?.id
          ? 'unchanged'
          : 'mapped';
    } else if (action === 'exclude') {
      outcome = existing?.status === 'excluded' ? 'unchanged' : 'excluded';
    } else {
      const settled =
        plan.setEmail === null &&
        existing !== undefined &&
        (existing.status === 'unmapped' || existing.status === 'pending_invite');
      outcome = settled ? 'unchanged' : 'invited';
    }
    // CSV `map` and `exclude` are explicit decisions and may replace an earlier one (AUTH-050 step 2
    // protects decisions from the matching cascade, not from the operator); the dry run says so.
    if (
      (outcome === 'mapped' || outcome === 'excluded') &&
      (existing?.status === 'confirmed' || existing?.status === 'excluded')
    ) {
      outcome = 'replaces_decision';
    }
    return { ...base, ok: true, errors, outcome, plan };
  });
}
