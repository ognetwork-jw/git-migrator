import { types } from 'node:util';
import {
  type AuthType,
  type ClientContract,
  ORMError,
  ORMErrorReason,
  TransactionIsolationLevel,
  ZenStackClient,
} from '@zenstackhq/orm';
import { PolicyPlugin } from '@zenstackhq/plugin-policy';
import Decimal from 'decimal.js';
import { PostgresDialect } from 'kysely';
import pg from 'pg';
import { createAuditPlugin } from './audit.ts';
import { type SchemaType, schema } from './generated/schema.ts';

/** A ZenStack client over the `app` schema. */
export type Db = ClientContract<SchemaType>;

type ModelKey = Uncapitalize<keyof SchemaType['models'] & string>;
type TransactionOptions = { isolationLevel?: TransactionIsolationLevel };

/**
 * What `forActor` returns (AUTH-021): a frozen object with a null prototype that exposes only the
 * model delegates, a read-only `$schema` and `$transaction`. It is an allow-list. The ZenStack client has many members
 * that bypass the policy plugin (`$qb`, `$qbRaw`, `kysely`, `kyselyRaw`, `withExecutor`,
 * `$options`, `$setAuth`, `$use`, `$unuse*`, `$executeRaw*`, `$queryRaw*`, ...) and a deny-list
 * cannot keep up with them, so none of them exists here. The client passed to a `$transaction`
 * callback is the same facade. The delegates are copies, so a holder cannot patch the originals.
 */
export type PolicyDb = Readonly<Pick<Db, ModelKey>> & {
  /** A deep-frozen copy of the schema, which the ZenStack RPC handler reads (ADR-0122). */
  readonly $schema: Db['$schema'];
  $transaction<T>(callback: (tx: PolicyDb) => Promise<T>, options?: TransactionOptions): Promise<T>;
  $transaction<P extends PromiseLike<unknown>[]>(
    operations: [...P],
    options?: TransactionOptions,
  ): Promise<{ [K in keyof P]: Awaited<P[K]> }>;
};

/**
 * The Actor that policies see as `auth()` (AUTH-020, AUTH-021). Only `id` and `role` are needed by
 * the policies; callers pass the whole Actor row they resolved from a session or API key.
 */
export type PolicyActor = AuthType<SchemaType>;

export interface CreateDbOptions {
  /** Assembled by `buildConnectionString` (DATA-010). */
  readonly connectionString: string;
  /** Pool size for this process (`postgres.pool.app`, default 10). */
  readonly poolMax?: number;
  /**
   * Called with the raw error of a failed facade call (not for policy rejections, missing rows or
   * invalid input), before it is sanitized. For logging only: reduce it to safe fields first, it can
   * carry SQL text and parameters.
   */
  readonly onError?: (error: unknown) => void;
  /** Reuse an existing pool instead of creating one. The caller then owns closing it. */
  readonly pool?: pg.Pool;
}

export interface DbHandle {
  /**
   * The privileged client (DOM-005, AUTH-021): no access policies. Server code only, behind a
   * custom endpoint or job that enforces the domain rules and writes audit. It is never exposed to
   * the ZenStack RPC handler and never handed to request-scoped code that has not checked
   * `can(actor, capability)`.
   */
  readonly privileged: Db;
  /**
   * A client that enforces the access policies for `actor`, for the ZenStack RPC mount (API-012).
   * Pass `undefined` for an unauthenticated caller: every read and write is then denied.
   *
   * The result is a facade (see `PolicyDb`), not a ZenStack client: it exposes the model delegates
   * a read-only `$schema` and `$transaction` and nothing else, so the holder cannot reach the query builders, the
   * executor, the plugins, the options or the pool, change Actor, or run raw SQL.
   */
  forActor(actor: PolicyActor | undefined): PolicyDb;
  /** The underlying pool, for LISTEN connections, advisory locks and the quota ledger (DATA-010). */
  readonly pool: pg.Pool;
  /** Closes the pool when this handle created it. */
  close(): Promise<void>;
}

/**
 * Creates the privileged client factory's result: one pool, one privileged client, and a function
 * that derives policy-enforcing clients from it.
 */
export function createDb(options: CreateDbOptions): DbHandle {
  const ownsPool = options.pool === undefined;
  const pool =
    options.pool ??
    new pg.Pool({ connectionString: options.connectionString, max: options.poolMax ?? 10 });
  // An idle connection the server closed (failover, restart) emits 'error'. Without a listener
  // that would crash the process; the pool discards the client and the next query reconnects.
  if (ownsPool) pool.on('error', () => undefined);
  const privileged = new ZenStackClient(schema, {
    dialect: new PostgresDialect({ pool }),
  }) as unknown as Db;
  // The audit plugin exists on the policed client only: it records what Actors do through RPC
  // (AUTH-022). Jobs and custom endpoints use `privileged` and write their own events.
  const policed = privileged.$use(new PolicyPlugin()).$use(createAuditPlugin()) as unknown as Db;
  return {
    privileged,
    forActor: (actor) => policyFacade(policed.$setAuth(actor) as Db, options.onError),
    pool,
    close: async () => {
      if (ownsPool) await pool.end();
    },
  };
}

const MODEL_KEYS: readonly string[] = Object.keys(schema.models).map(
  (name) => name.charAt(0).toLowerCase() + name.slice(1),
);

type AnyFn = (...args: unknown[]) => unknown;

/** Fields that no role may read (`@deny('read', true)`): they must not leak through ordering either. */
const READ_DENIED_FIELDS: Readonly<Record<string, readonly string[]>> = { ApiKey: ['hash'] };
const AGGREGATE_KEYS: ReadonlySet<string> = new Set(['_min', '_max', '_count', '_sum', '_avg']);

type FieldDef = { type: string; relation?: unknown };
const fieldsOf = (model: string): Record<string, FieldDef> | undefined =>
  (schema.models as unknown as Record<string, { fields: Record<string, FieldDef> }>)[model]?.fields;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Refuses ordering, grouping and aggregating by a read-denied field, at any depth of `orderBy`,
 * `include` and `select`. A denied field reads as null, but sorting by it would still reveal the
 * order of the stored hashes (a bytewise oracle). `args` is already a plain-data clone.
 */
function assertNoDeniedFieldUse(model: string, args: unknown): void {
  if (!isRecord(args)) return;
  const denied = READ_DENIED_FIELDS[model] ?? [];
  const fields = fieldsOf(model) ?? {};
  const refuseOrder = (value: unknown, current: string): void => {
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (!isRecord(entry)) continue;
      for (const [name, sub] of Object.entries(entry)) {
        const def = fieldsOf(current)?.[name];
        if (def?.relation) refuseOrder(sub, def.type);
        else if (READ_DENIED_FIELDS[current]?.includes(name)) {
          throw refusal(`ordering by ${current}.${name} is not allowed`);
        }
      }
    }
  };
  if ('orderBy' in args) refuseOrder(args.orderBy, model);
  if (Array.isArray(args.by) && args.by.some((f) => denied.includes(String(f)))) {
    throw refusal('grouping by a denied field is not allowed');
  }
  for (const [key, value] of Object.entries(args)) {
    if (AGGREGATE_KEYS.has(key) && isRecord(value) && denied.some((f) => f in value)) {
      throw refusal('aggregating a denied field is not allowed');
    }
    if (key === 'include' || key === 'select') {
      for (const [name, sub] of Object.entries(isRecord(value) ? value : {})) {
        const def = fields[name];
        if (def?.relation) assertNoDeniedFieldUse(def.type, sub);
      }
    }
  }
}

/** Delegate operations that read (ZenStack names). */
const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'exists',
]);

function deepFreezeCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeCopy)) as T;
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = deepFreezeCopy(entry);
    return Object.freeze(copy) as T;
  }
  return value;
}

/** Shared by every facade: frozen all the way down, so a holder cannot edit policy definitions. */
const FROZEN_SCHEMA = deepFreezeCopy(schema);

const MAX_ARG_DEPTH = 64;
/** Most values (objects, arrays and leaves) one call may hold; a DAG of shared references is refused anyway. */
const MAX_ARG_NODES = 10_000;
/** Most string characters (values and keys) one call may hold. */
const MAX_ARG_STRING_CHARS = 1_000_000;

interface Walk {
  readonly ancestors: Set<object>;
  readonly seen: WeakSet<object>;
  nodes: number;
  chars: number;
}

const newWalk = (): Walk => ({ ancestors: new Set(), seen: new WeakSet(), nodes: 0, chars: 0 });

const refusal = (message: string): ORMError => new ORMError(ORMErrorReason.INVALID_INPUT, message);

const DECIMAL_OWN_KEYS: ReadonlySet<PropertyKey> = new Set(['constructor', 's', 'e', 'd']);
const ISOLATION_LEVELS: ReadonlySet<unknown> = new Set(Object.values(TransactionIsolationLevel));

/**
 * Reads one own data property. The value is read from the descriptor, once, so a getter (refused
 * earlier) or a lying `get` trap cannot return different values to the walk and to ZenStack.
 */
function dataValue(obj: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key) as PropertyDescriptor;
  if (!('value' in descriptor)) throw refusal('arguments must not have accessor properties');
  return descriptor.value;
}

/** A Date, Decimal or Uint8Array leaf rebuilt from its internal value, or `undefined` if `obj` is none. */
function cloneLeaf(obj: object): unknown {
  const proto = Object.getPrototypeOf(obj);
  if (types.isDate(obj) || proto === Date.prototype) {
    // Exact type: the prototype is Date.prototype, the brand is a real Date, and there are no own
    // keys (an own `$expr` or a shadowed method would survive a naive copy).
    if (proto !== Date.prototype || !types.isDate(obj) || Reflect.ownKeys(obj).length > 0) {
      throw refusal('arguments may only hold plain Date values');
    }
    return new Date(Date.prototype.getTime.call(obj));
  }
  if (proto === Decimal.prototype || obj instanceof Decimal) {
    const keys = Reflect.ownKeys(obj);
    if (
      proto !== Decimal.prototype ||
      !keys.every((k) => DECIMAL_OWN_KEYS.has(k)) ||
      !(['s', 'e', 'd'] as const).every((k) => keys.includes(k)) ||
      dataValue(obj, 'constructor') !== Decimal
    ) {
      throw refusal('arguments may only hold plain Decimal values');
    }
    for (const key of ['s', 'e', 'd']) dataValue(obj, key);
    try {
      return new Decimal(Decimal.prototype.toString.call(obj));
    } catch {
      throw refusal('arguments may only hold plain Decimal values');
    }
  }
  if (types.isUint8Array(obj) || proto === Uint8Array.prototype) {
    const exact = proto === Uint8Array.prototype || proto === Buffer.prototype;
    if (!exact || !types.isUint8Array(obj) || Reflect.ownKeys(obj).length !== obj.length) {
      throw refusal('arguments may only hold plain Uint8Array values');
    }
    const copy = new Uint8Array(obj.length);
    copy.set(obj);
    return copy;
  }
  return undefined;
}

/**
 * Validates and copies the arguments of a delegate call before any query is built (AUTH-021,
 * ADR-0200). Only data is allowed: plain objects and arrays, primitives, and exact Date, Decimal
 * and Uint8Array values. The result is a fresh plain-data deep clone, and only the clone reaches
 * ZenStack. That closes four holes of an inspect-then-pass walk: a Date, Decimal or Uint8Array
 * carrying an own `$expr`; a forged prototype (`Object.create(Date.prototype)`); a Proxy whose
 * traps answer the walk differently from ZenStack's later reads; and arguments the caller changes
 * after the call, which ZenStack reads lazily. A function (above all the callback of a
 * `where.$expr`, which hands the caller the SQL expression builder and with it raw SQL beneath the
 * policy plugin) or any other object is refused at any depth, and so is a Proxy, a key named
 * `$expr` or `__proto__`, a symbol key, an accessor property, a cycle, a value reached twice (shared reference), nesting deeper than 64, more than
 * 10,000 values and more than 1,000,000 string characters.
 */
function cloneData(value: unknown, walk: Walk = newWalk()): unknown {
  if (++walk.nodes > MAX_ARG_NODES) throw refusal('arguments are too large');
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') {
    walk.chars += (value as string).length;
    if (walk.chars > MAX_ARG_STRING_CHARS) throw refusal('arguments are too large');
    return value;
  }
  if (type === 'number' || type === 'boolean' || type === 'bigint') return value;
  if (type !== 'object') throw refusal(`arguments may only hold data, found a ${type}`);
  const obj = value as object;
  if (types.isProxy(obj)) throw refusal('arguments must not contain a Proxy');
  const leaf = cloneLeaf(obj);
  if (leaf !== undefined) return leaf;
  if (walk.ancestors.has(obj)) throw refusal('arguments must not contain a cycle');
  // A value reached twice is a shared reference. JSON cannot express one, but SuperJSON
  // `referentialEqualities` can, and a DAG copied once per path takes exponential time.
  if (walk.seen.has(obj)) throw refusal('arguments must not contain shared references');
  walk.seen.add(obj);
  if (walk.ancestors.size >= MAX_ARG_DEPTH) throw refusal('arguments are nested too deeply');
  const proto = Object.getPrototypeOf(obj);
  const isArray = Array.isArray(obj);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    throw refusal('arguments may only hold plain objects and arrays');
  }
  walk.ancestors.add(obj);
  const clone: unknown[] | Record<string, unknown> = isArray ? new Array(obj.length) : {};
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'symbol') throw refusal('arguments must not have symbol keys');
    if (key === '$expr') throw refusal('$expr is not allowed');
    if (key === '__proto__') throw refusal('arguments must not have a __proto__ key');
    if (isArray && key === 'length') continue;
    walk.chars += key.length;
    // defineProperty, so no key can run a setter or change the clone's prototype.
    Object.defineProperty(clone, key, {
      value: cloneData(dataValue(obj, key), walk),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  walk.ancestors.delete(obj);
  return clone;
}

/** Transaction options are plain data too: a known isolation level or nothing. */
function cloneTransactionOptions(options: unknown): TransactionOptions | undefined {
  if (options === undefined) return undefined;
  const clone = cloneData(options) as Record<string, unknown> | null;
  if (clone === null || typeof clone !== 'object' || Array.isArray(clone)) {
    throw refusal('transaction options must be an object');
  }
  for (const key of Object.keys(clone)) {
    if (key !== 'isolationLevel') throw refusal(`unknown transaction option ${key}`);
  }
  const level = clone.isolationLevel;
  if (level !== undefined && !ISOLATION_LEVELS.has(level)) {
    throw refusal('unknown transaction isolation level');
  }
  return clone as TransactionOptions;
}

/**
 * ORM errors carry `sql`, `sqlParams`, `dbErrorMessage` and a `cause`, which would put query
 * parameters (possibly secrets) into any log that prints the error. The facade rethrows a fresh
 * ORMError with the reason, the model, the policy reason code, the database error code and a
 * generic message. The RPC handler classifies by `reason`, so its status codes are unchanged.
 * Input errors keep their message (it describes the caller's own input). Any other error that carries
 * `sql`, `sqlParams` or node-postgres fields (on itself or in its `cause` chain) becomes a generic
 * database error. Other errors pass through.
 */
const GENERIC: Record<string, string> = {
  [ORMErrorReason.NOT_FOUND]: 'record not found',
  [ORMErrorReason.REJECTED_BY_POLICY]: 'operation rejected by policy',
  [ORMErrorReason.DB_QUERY_ERROR]: 'database query failed',
};

/** Properties of a query error (Kysely, ZenStack) or a node-postgres `DatabaseError`. */
const DB_DETAIL_KEYS = [
  'sql',
  'sqlParams',
  'parameters',
  'dbErrorMessage',
  'severity',
  'detail',
  'hint',
  'schema',
  'table',
  'column',
  'dataType',
  'constraint',
  'internalQuery',
  'routine',
  'position',
] as const;

/** True when an error, or something in its `cause` chain, carries SQL text, parameters or pg fields. */
function carriesDbDetail(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 5) return false;
  if (DB_DETAIL_KEYS.some((key) => key in error)) return true;
  return carriesDbDetail((error as { cause?: unknown }).cause, depth + 1);
}

function sanitizeError(error: unknown): unknown {
  if (!(error instanceof ORMError)) {
    // An error thrown by a callback, or a driver error ZenStack did not wrap, may carry the query
    // and its parameters (possibly secrets). It becomes the same generic error as a wrapped one.
    if (!carriesDbDetail(error)) return error;
    const code = (error as { code?: unknown }).code;
    const clean = new ORMError(
      ORMErrorReason.DB_QUERY_ERROR,
      GENERIC[ORMErrorReason.DB_QUERY_ERROR],
    );
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) clean.dbErrorCode = code;
    return clean;
  }
  const message =
    error.reason === ORMErrorReason.INVALID_INPUT
      ? error.message
      : (GENERIC[error.reason] ?? 'internal error');
  const clean = new ORMError(error.reason, message);
  if (error.model !== undefined) clean.model = error.model;
  if (error.dbErrorCode !== undefined) clean.dbErrorCode = error.dbErrorCode;
  if (error.rejectedByPolicyReason !== undefined) {
    clean.rejectedByPolicyReason = error.rejectedByPolicyReason;
  }
  return clean;
}

/** Error reasons that are the caller's own doing and not worth an operator's attention. */
const EXPECTED_REASONS: ReadonlySet<string> = new Set([
  ORMErrorReason.NOT_FOUND,
  ORMErrorReason.REJECTED_BY_POLICY,
  ORMErrorReason.INVALID_INPUT,
]);

type ErrorObserver = (error: unknown) => void;

/**
 * Hands the raw error to the observer (for logging, with its own scrubbing) and rethrows the
 * sanitized one. Policy rejections, missing rows and invalid input are not reported.
 */
const makeRethrow =
  (observe: ErrorObserver | undefined) =>
  (error: unknown): never => {
    if (observe && !(error instanceof ORMError && EXPECTED_REASONS.has(error.reason))) {
      try {
        observe(error);
      } catch {
        // An observer must never change the outcome of a database call.
      }
    }
    throw sanitizeError(error);
  };

interface Issued {
  op: PromiseLike<unknown> | undefined;
  owner: object;
  /** Set when the call was refused before any query was built. */
  refused?: ORMError;
}

/**
 * Delegate calls return an opaque thenable (own keys `then`, `catch`, `finally`, no `cb`). The real
 * ZenStack promise is kept here, keyed by the thenable, and only the facade that issued it can
 * unwrap it for the array form of `$transaction`. A forged `{ then, cb }` is not in the map.
 */
const ISSUED = new WeakMap<object, Issued>();

function opaque(
  rethrow: (error: unknown) => never,
  op: PromiseLike<unknown> | undefined,
  owner: object,
  refused?: ORMError,
): PromiseLike<unknown> {
  // The ZenStack promise is lazy: nothing runs until it is awaited or handed to `$transaction`.
  let safe: Promise<unknown> | undefined;
  const run = (): Promise<unknown> => {
    safe ??=
      refused === undefined
        ? (op as Promise<unknown>).then((v) => v, rethrow)
        : Promise.reject(refused);
    return safe;
  };
  const wrapper = Object.freeze(
    Object.assign(Object.create(null) as object, {
      // biome-ignore lint/suspicious/noThenProperty: the facade returns a deliberate opaque thenable
      then: (a?: AnyFn, b?: AnyFn) => run().then(a as never, b as never),
      catch: (b?: AnyFn) => run().catch(b as never),
      finally: (f?: AnyFn) => run().finally(f as never),
    }),
  ) as PromiseLike<unknown>;
  ISSUED.set(wrapper, { op, owner, ...(refused === undefined ? {} : { refused }) });
  return wrapper;
}

/** Builds the `PolicyDb` facade over a policy-enforcing client (AUTH-021). */
function policyFacade(client: Db, observe?: ErrorObserver): PolicyDb {
  const rethrow = makeRethrow(observe);
  const facade: Record<string, unknown> = Object.create(null);
  for (const key of MODEL_KEYS) {
    const modelName = key.charAt(0).toUpperCase() + key.slice(1);
    const delegate = (client as unknown as Record<string, Record<string, AnyFn>>)[key] as Record<
      string,
      AnyFn
    >;
    const copy: Record<string, AnyFn> = Object.create(null);
    for (const name of Object.keys(delegate)) {
      // The audit plugin writes AuditEvent as the Actor (ADR-0201); no RPC caller may.
      if (key === 'auditEvent' && !READ_OPERATIONS.has(name)) continue;
      copy[name] = (...args) => {
        let safe: unknown[];
        try {
          // Only the clone reaches ZenStack, which reads its arguments lazily (ADR-0200).
          safe = cloneData(args) as unknown[];
          assertNoDeniedFieldUse(modelName, safe[0]);
        } catch (error) {
          return opaque(rethrow, undefined, client, sanitizeError(error) as ORMError);
        }
        return opaque(rethrow, (delegate[name] as AnyFn).apply(delegate, safe) as never, client);
      };
    }
    facade[key] = Object.freeze(copy);
  }
  facade.$schema = FROZEN_SCHEMA;
  facade.$transaction = (arg: unknown, rawOptions?: unknown): unknown => {
    let options: TransactionOptions | undefined;
    try {
      options = cloneTransactionOptions(rawOptions);
    } catch (error) {
      return Promise.reject(error);
    }
    if (typeof arg === 'function') {
      return Promise.resolve(
        (client.$transaction as AnyFn).call(
          client,
          (tx: Db) => (arg as (tx: PolicyDb) => unknown)(policyFacade(tx, observe)),
          options,
        ),
      ).then((v) => v, rethrow);
    }
    // The array form is what the RPC transaction route uses. Each element must be a thenable this
    // very facade issued; nothing runs unless all of them are.
    if (Array.isArray(arg)) {
      const originals: PromiseLike<unknown>[] = [];
      for (const item of arg as unknown[]) {
        const issued = typeof item === 'object' && item !== null ? ISSUED.get(item) : undefined;
        if (issued === undefined || issued.owner !== client) {
          return Promise.reject(
            refusal('$transaction accepts only operations issued by this client'),
          );
        }
        if (issued.refused !== undefined) return Promise.reject(issued.refused);
        originals.push(issued.op as PromiseLike<unknown>);
      }
      return Promise.resolve((client.$transaction as AnyFn).call(client, originals, options)).then(
        (v) => v,
        rethrow,
      );
    }
    return Promise.reject(refusal('$transaction expects a callback or an array of operations'));
  };
  return Object.freeze(facade) as PolicyDb;
}
