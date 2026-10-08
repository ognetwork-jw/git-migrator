import { describe, expect, it } from 'vitest';
import {
  checkRow,
  MAX_CSV_CELL,
  MAX_CSV_ROWS,
  neutralizeCell,
  parseMappingCsv,
  startsLikeFormula,
} from './csv.ts';

const HEADER = 'source,target,action\n';

describe('[AUTH-050] CSV parsing', () => {
  it('[AUTH-050] parses rows with the header source,target,action', () => {
    const parsed = parseMappingCsv(
      `${HEADER}alice,alice-gh,map\nbob,bob@example.test,invite\ncarol,,exclude\n`,
    );
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows.map((r) => [r.line, r.source, r.target, r.action, r.errors])).toEqual([
      [2, 'alice', 'alice-gh', 'map', []],
      [3, 'bob', 'bob@example.test', 'invite', []],
      [4, 'carol', '', 'exclude', []],
    ]);
  });

  it('[AUTH-050] accepts CRLF, a BOM, a header in any case and blank lines', () => {
    const parsed = parseMappingCsv('﻿Source,Target,ACTION\r\n\r\nalice,a,MAP\r\n');
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      source: 'alice',
      target: 'a',
      action: 'map',
      errors: [],
    });
  });

  it('[AUTH-050] handles quoted cells with commas, doubled quotes and line breaks', () => {
    const parsed = parseMappingCsv(
      `${HEADER}"a,b",x,map\n"q""r",y,map\n"l1\nl2",z,map\nlast,t,map\n`,
    );
    expect(parsed.rows.map((r) => r.source)).toEqual(['a,b', 'q"r', 'l1\nl2', 'last']);
    // The line number is that of the row's first line, so a multi-line cell does not shift it.
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 3, 4, 6]);
  });

  it('[AUTH-050] rejects an empty file, a wrong header and an unterminated quote as file errors', () => {
    expect(parseMappingCsv('  \n').fileErrors).toEqual(['file_empty']);
    expect(parseMappingCsv('a,b,c\nx,y,map\n').fileErrors).toEqual(['header_invalid']);
    expect(parseMappingCsv('source,target\nx,y\n').fileErrors).toEqual(['header_invalid']);
    expect(parseMappingCsv(`${HEADER}"open,x,map\n`).fileErrors).toEqual(['unterminated_quote']);
  });

  it('[AUTH-050] rejects a file with too many rows', () => {
    const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `u${i},t${i},map`).join('\n');
    expect(parseMappingCsv(`${HEADER}${rows}`).fileErrors).toEqual(['too_many_rows']);
    const ok = Array.from({ length: MAX_CSV_ROWS }, (_, i) => `u${i},t${i},map`).join('\n');
    expect(parseMappingCsv(`${HEADER}${ok}`).fileErrors).toEqual([]);
  });

  it('[AUTH-050] flags a row with the wrong number of cells without dropping the others', () => {
    const parsed = parseMappingCsv(`${HEADER}a,b\nc,d,map,extra\ne,f,map\n`);
    expect(parsed.rows.map((r) => r.errors)).toEqual([['column_count'], ['column_count'], []]);
  });

  it('[AUTH-050] flags missing sources, bad actions, and targets that do not fit the action', () => {
    expect(checkRow('', 't', 'map')).toEqual(['source_missing']);
    expect(checkRow('s', 't', 'delete')).toEqual(['action_invalid']);
    expect(checkRow('s', '', 'map')).toEqual(['target_missing']);
    expect(checkRow('s', '', 'invite')).toEqual(['target_missing']);
    expect(checkRow('s', 'not-an-email', 'invite')).toEqual(['target_not_email']);
    expect(checkRow('s', 'x', 'exclude')).toEqual(['target_not_allowed']);
    expect(checkRow('s', 'a@b.test', 'invite')).toEqual([]);
    expect(checkRow('s', '', 'exclude')).toEqual([]);
  });

  it('[AUTH-050] flags control characters and over-long cells', () => {
    expect(checkRow('a\u0000b', 't', 'map')).toEqual(['control_characters']);
    expect(checkRow('a‮', 't', 'map')).toEqual([]);
    expect(checkRow('s'.repeat(MAX_CSV_CELL + 1), 't', 'map')).toEqual(['cell_too_long']);
    expect(checkRow('s'.repeat(MAX_CSV_CELL), 't', 'map')).toEqual([]);
  });

  it('[AUTH-050] rejects targets that start like a spreadsheet formula', () => {
    for (const target of ['=cmd', '+1', '-2', '@SUM(A1)']) {
      expect(checkRow('s', target, 'map')).toContain('formula_prefix');
    }
    expect(checkRow('s', 'ok-login', 'map')).toEqual([]);
  });
});

describe('[AUTH-050] CSV injection guard', () => {
  it('[AUTH-050] neutralizes cells starting with = + - @ tab or carriage return', () => {
    for (const cell of ['=1+1', '+1', '-1', '@x', '\tx', '\rx']) {
      expect(startsLikeFormula(cell)).toBe(true);
      expect(neutralizeCell(cell)).toBe(`'${cell}`);
    }
  });

  it('[AUTH-050] leaves ordinary cells unchanged', () => {
    for (const cell of ['alice', 'a=b', '', "'quoted", 'a@b.test']) {
      expect(neutralizeCell(cell)).toBe(cell);
    }
  });
});
