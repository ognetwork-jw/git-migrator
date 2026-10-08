/**
 * The Identity mapping CSV (AUTH-050 step 3): header `source,target,action`. Pure parsing and
 * per-row syntax checks; resolving the cells against Identities happens in `service.ts`.
 *
 * The whole file is validated before anything is applied, and every problem is reported per row
 * with a stable code that the UI renders from `mapping.csv.error.<code>`.
 */

export const CSV_HEADER = ['source', 'target', 'action'] as const;
export const CSV_ACTIONS = ['map', 'invite', 'exclude'] as const;
export type CsvAction = (typeof CSV_ACTIONS)[number];

/** Most data rows one import may carry. */
export const MAX_CSV_ROWS = 5000;
/** Longest cell, in characters (an email address is at most 320). */
export const MAX_CSV_CELL = 320;

export const CSV_ERROR_CODES = [
  'file_empty',
  'header_invalid',
  'too_many_rows',
  'unterminated_quote',
  'column_count',
  'source_missing',
  'action_invalid',
  'target_missing',
  'target_not_allowed',
  'target_not_email',
  'cell_too_long',
  'control_characters',
  'formula_prefix',
  'source_not_found',
  'source_ambiguous',
  'target_not_found',
  'target_ambiguous',
  'duplicate_source',
  'target_taken',
  'email_conflict',
  'already_decided',
] as const;
export type CsvErrorCode = (typeof CSV_ERROR_CODES)[number];

export interface ParsedCsvRow {
  /** 1-based line number of the row's first line in the file (the header is line 1). */
  readonly line: number;
  readonly source: string;
  readonly target: string;
  readonly action: string;
  /** Syntax errors found by `checkRow`; resolution errors are added later. */
  readonly errors: readonly CsvErrorCode[];
}

export interface ParsedCsv {
  /** Problems with the file as a whole. When non-empty, `rows` may be empty. */
  readonly fileErrors: readonly CsvErrorCode[];
  readonly rows: readonly ParsedCsvRow[];
}

/**
 * Cells a spreadsheet would run as a formula. Anything echoed back from a file or placed in an
 * export starts with this guard so it stays text (OWASP "CSV injection").
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** True when `cell` would be read as a formula by a spreadsheet. */
export const startsLikeFormula = (cell: string): boolean => FORMULA_START.test(cell);

/** Makes a cell safe to show or export: a leading `'` keeps `=`, `+`, `-`, `@` from being a formula. */
export const neutralizeCell = (cell: string): string =>
  startsLikeFormula(cell) ? `'${cell}` : cell;

/** C0 and C1 control characters (tab and line breaks inside quoted cells excepted) and U+2028/9. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

interface RawRecord {
  readonly line: number;
  readonly cells: string[];
}

/**
 * RFC 4180 tokenizer: quoted cells may hold commas, doubled quotes and line breaks. Returns
 * `undefined` for an unterminated quote.
 */
function tokenize(text: string): RawRecord[] | undefined {
  const records: RawRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let wasQuoted = false;
  let line = 1;
  let startLine = 1;
  let touched = false;
  const endCell = () => {
    cells.push(cell);
    cell = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endCell();
    records.push({ line: startLine, cells });
    cells = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (!touched) {
      startLine = line;
      touched = true;
    }
    if (ch === '"' && cell === '' && !wasQuoted) {
      inQuotes = true;
      wasQuoted = true;
    } else if (ch === ',') {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
    } else {
      cell += ch;
    }
  }
  if (inQuotes) return undefined;
  if (touched || cell !== '' || cells.length > 0) endRecord();
  return records;
}

/** Syntax checks of one row (`source`, `target`, `action` already trimmed). */
export function checkRow(source: string, target: string, action: string): CsvErrorCode[] {
  const errors: CsvErrorCode[] = [];
  const add = (code: CsvErrorCode) => {
    if (!errors.includes(code)) errors.push(code);
  };
  if ([source, target, action].some((c) => c.length > MAX_CSV_CELL)) add('cell_too_long');
  if ([source, target, action].some((c) => CONTROL.test(c))) add('control_characters');
  if (source === '') add('source_missing');
  const validAction = (CSV_ACTIONS as readonly string[]).includes(action);
  if (!validAction) add('action_invalid');
  if (target !== '' && startsLikeFormula(target)) add('formula_prefix');
  if (validAction) {
    if (action === 'exclude') {
      if (target !== '') add('target_not_allowed');
    } else if (target === '') {
      add('target_missing');
    } else if (
      action === 'invite' &&
      !/^[^\s@,;"'<>()[\]\\]+@[^\s@,;"'<>()[\]\\]+\.[^\s@,;"'<>()[\]\\]+$/.test(target)
    ) {
      add('target_not_email');
    }
  }
  return errors;
}

/** Parses the import text. Never throws; problems come back as codes. */
export function parseMappingCsv(input: string): ParsedCsv {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  if (text.trim() === '') return { fileErrors: ['file_empty'], rows: [] };
  const records = tokenize(text);
  if (records === undefined) return { fileErrors: ['unterminated_quote'], rows: [] };
  const [header, ...body] = records as [RawRecord, ...RawRecord[]];
  const names = header.cells.map((c) => c.trim().toLowerCase());
  if (names.length !== CSV_HEADER.length || names.some((n, i) => n !== CSV_HEADER[i])) {
    return { fileErrors: ['header_invalid'], rows: [] };
  }
  // Blank lines are not rows.
  const data = body.filter((r) => !(r.cells.length === 1 && (r.cells[0] as string).trim() === ''));
  if (data.length > MAX_CSV_ROWS) return { fileErrors: ['too_many_rows'], rows: [] };
  const rows = data.map((record): ParsedCsvRow => {
    if (record.cells.length !== CSV_HEADER.length) {
      return {
        line: record.line,
        source: (record.cells[0] ?? '').trim(),
        target: '',
        action: '',
        errors: ['column_count'],
      };
    }
    const [source, target, action] = record.cells.map((c) => c.trim()) as [string, string, string];
    return {
      line: record.line,
      source,
      target,
      action: action.toLowerCase(),
      errors: checkRow(source, target, action.toLowerCase()),
    };
  });
  return { fileErrors: [], rows };
}
