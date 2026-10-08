/**
 * Generic helpers shared by the list endpoints of the fakes: Bitbucket-style `q` filtering,
 * `sort` and `fields` handling over plain serialized JSON objects.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = Record<string, unknown>;

export function getPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Obj)[part];
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------
// q= filtering: `field = "x"`, `!=`, `~`, `!~`, `<`, `<=`, `>`, `>=`, AND, OR, NOT, parentheses.
// ---------------------------------------------------------------------------------------------

type Token = { t: 'str' | 'num' | 'word' | 'op' | 'lp' | 'rp'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) i++;
    else if (c === '(' || c === ')') {
      out.push({ t: c === '(' ? 'lp' : 'rp', v: c });
      i++;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new QueryError('unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
    } else if (/[!<>=~]/.test(c)) {
      let j = i;
      while (j < src.length && /[!<>=~]/.test(src[j] as string)) j++;
      out.push({ t: 'op', v: src.slice(i, j) });
      i = j;
    } else {
      let j = i;
      while (j < src.length && !/[\s()"!<>=~]/.test(src[j] as string)) j++;
      const w = src.slice(i, j);
      out.push({ t: /^-?\d+(\.\d+)?$/.test(w) ? 'num' : 'word', v: w });
      i = j;
    }
  }
  return out;
}

export class QueryError extends Error {}

type Pred = ((o: unknown) => boolean) & { fields?: string[] };

function literal(tok: Token | undefined): unknown {
  if (!tok) throw new QueryError('missing value');
  if (tok.t === 'str') return tok.v;
  if (tok.t === 'num') return Number(tok.v);
  if (tok.t === 'word' && tok.v === 'true') return true;
  if (tok.t === 'word' && tok.v === 'false') return false;
  if (tok.t === 'word' && tok.v === 'null') return null;
  throw new QueryError(`bad value ${tok.v}`);
}

function compare(op: string, actual: unknown, expected: unknown): boolean {
  const a = actual === undefined ? null : actual;
  switch (op) {
    case '=':
      return a === expected;
    case '!=':
      return a !== expected;
    case '~':
      return typeof a === 'string' && a.toLowerCase().includes(String(expected).toLowerCase());
    case '!~':
      return !(typeof a === 'string' && a.toLowerCase().includes(String(expected).toLowerCase()));
    case '<':
      return a !== null && (a as number | string) < (expected as number | string);
    case '<=':
      return a !== null && (a as number | string) <= (expected as number | string);
    case '>':
      return a !== null && (a as number | string) > (expected as number | string);
    case '>=':
      return a !== null && (a as number | string) >= (expected as number | string);
    default:
      throw new QueryError(`unknown operator ${op}`);
  }
}

export function parseQuery(src: string): Pred {
  const toks = tokenize(src);
  const fields: string[] = [];
  let pos = 0;
  const peek = () => toks[pos];
  const isWord = (w: string) => peek()?.t === 'word' && (peek() as Token).v.toUpperCase() === w;

  function parseOr(): Pred {
    let left = parseAnd();
    while (isWord('OR')) {
      pos++;
      const l = left;
      const r = parseAnd();
      left = (o) => l(o) || r(o);
    }
    return left;
  }
  function parseAnd(): Pred {
    let left = parseUnary();
    while (isWord('AND')) {
      pos++;
      const l = left;
      const r = parseUnary();
      left = (o) => l(o) && r(o);
    }
    return left;
  }
  function parseUnary(): Pred {
    if (isWord('NOT')) {
      pos++;
      const inner = parseUnary();
      return (o) => !inner(o);
    }
    if (peek()?.t === 'lp') {
      pos++;
      const inner = parseOr();
      if (peek()?.t !== 'rp') throw new QueryError('expected )');
      pos++;
      return inner;
    }
    const field = peek();
    if (field?.t !== 'word') throw new QueryError('expected field name');
    pos++;
    const op = peek();
    if (op?.t !== 'op') throw new QueryError('expected operator');
    pos++;
    const expected = literal(peek());
    pos++;
    fields.push(field.v);
    return (o) => compare(op.v, getPath(o, field.v), expected);
  }

  const pred = parseOr();
  if (pos < toks.length) throw new QueryError(`unexpected ${toks[pos]?.v}`);
  return Object.assign((o: unknown) => pred(o), { fields });
}

export function applyQuery<T>(items: T[], q: string | undefined): T[] {
  if (!q) return items;
  const pred = parseQuery(q);
  for (const f of pred.fields ?? []) assertKnownField(items, f, 'q');
  return items.filter(pred);
}

/** A field no returned object has is a client error, like the real API's "invalid field" 400. */
function assertKnownField(items: unknown[], field: string, param: string): void {
  if (items.length > 0 && !items.some((i) => getPath(i, field) !== undefined)) {
    throw new QueryError(`Unknown field '${field}' in ${param}`);
  }
}

export function applySort<T>(items: T[], sort: string | undefined): T[] {
  if (!sort) return items;
  const desc = sort.startsWith('-');
  const key = desc ? sort.slice(1) : sort;
  assertKnownField(items, key, 'sort');
  const sorted = [...items].sort((x, y) => {
    const a = getPath(x, key) as string | number | null | undefined;
    const b = getPath(y, key) as string | number | null | undefined;
    if (a === b) return 0;
    if (a === undefined || a === null) return -1;
    if (b === undefined || b === null) return 1;
    return a < b ? -1 : 1;
  });
  return desc ? sorted.reverse() : sorted;
}

// ---------------------------------------------------------------------------------------------
// fields= partial responses. Only include-lists are narrowed; a leading `+` (add to defaults) or
// `-` (remove) is honoured for `-` and ignored for `+`.
// ---------------------------------------------------------------------------------------------

function pick(value: unknown, paths: string[][]): unknown {
  if (Array.isArray(value)) return value.map((v) => pick(v, paths));
  if (value === null || typeof value !== 'object') return value;
  const src = value as Obj;
  const out: Obj = {};
  const heads = new Set(paths.map((p) => p[0] as string));
  for (const head of heads) {
    if (!(head in src)) continue;
    const tails = paths.filter((p) => p[0] === head && p.length > 1).map((p) => p.slice(1));
    const whole = paths.some((p) => p[0] === head && p.length === 1);
    out[head] = whole || tails.length === 0 ? src[head] : pick(src[head], tails);
  }
  return out;
}

function omit(value: unknown, paths: string[][]): unknown {
  if (Array.isArray(value)) return value.map((v) => omit(v, paths));
  if (value === null || typeof value !== 'object') return value;
  const out: Obj = { ...(value as Obj) };
  for (const p of paths) {
    const [head, ...rest] = p as [string, ...string[]];
    if (!(head in out)) continue;
    if (rest.length === 0) delete out[head];
    else out[head] = omit(out[head], [rest]);
  }
  return out;
}

export function applyFields(body: unknown, fields: string | undefined): unknown {
  if (!fields) return body;
  const parts = fields
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const removals = parts.filter((p) => p.startsWith('-')).map((p) => p.slice(1).split('.'));
  const includes = parts.filter((p) => !p.startsWith('-') && !p.startsWith('+'));
  const hasPlus = parts.some((p) => p.startsWith('+'));
  let out = body;
  if (includes.length > 0 && !hasPlus)
    out = pick(
      out,
      includes.map((p) => p.split('.')),
    );
  if (removals.length > 0) out = omit(out, removals);
  return out;
}
