import {
  type AuthType,
  type ClientContract,
  ORMError,
  ORMErrorReason,
  type TransactionIsolationLevel,
  ZenStackClient,
} from '@zenstackhq/orm';
import { PolicyPlugin } from '@zenstackhq/plugin-policy';
import Decimal from 'decimal.js';
import { PostgresDialect } from 'kysely';
import pg from 'pg';
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
  const policed = privileged.$use(new PolicyPlugin()) as unknown as Db;
  return {
    privileged,
    forActor: (actor) => policyFacade(policed.$setAuth(actor) as Db),
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

const refusal = (message: string): ORMError => new ORMError(ORMErrorReason.INVALID_INPUT, message);

/**
 * Walks the arguments of a delegate call before any query is built (AUTH-021). Only data is
 * allowed: plain objects and arrays, primitives, Date, Decimal and Uint8Array. A function (above
 * all the callback of a `where.$expr`, which hands the caller the SQL expression builder and with
 * it raw SQL beneath the policy plugin) or any other object is refused at any depth, and so is a
 * key named `$expr`, a symbol key, an accessor property, a cycle and nesting deeper than 64 levels.
 */
function assertPlainData(value: unknown, ancestors: Set<object> = new Set()): void {
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') return;
  if (type !== 'object') throw refusal(`arguments may only hold data, found a ${type}`);
  const obj = value as object;
  if (obj instanceof Date || obj instanceof Decimal || obj instanceof Uint8Array) return;
  if (ancestors.has(obj)) throw refusal('arguments must not contain a cycle');
  if (ancestors.size >= MAX_ARG_DEPTH) throw refusal('arguments are nested too deeply');
  const proto = Object.getPrototypeOf(obj);
  const isArray = Array.isArray(obj);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    throw refusal('arguments may only hold plain objects and arrays');
  }
  ancestors.add(obj);
  for (const key of Reflect.ownKeys(obj)) {
    if (typeof key === 'symbol') throw refusal('arguments must not have symbol keys');
    if (key === '$expr') throw refusal('$expr is not allowed');
    const descriptor = Object.getOwnPropertyDescriptor(obj, key) as PropertyDescriptor;
    if (!('value' in descriptor)) throw refusal('arguments must not have accessor properties');
    if (isArray && key === 'length') continue;
    assertPlainData(descriptor.value, ancestors);
  }
  ancestors.delete(obj);
}

/**
 * ORM errors carry `sql`, `sqlParams`, `dbErrorMessage` and a `cause`, which would put query
 * parameters (possibly secrets) into any log that prints the error. The facade rethrows a fresh
 * ORMError with the reason, the model, the policy reason code, the database error code and a
 * generic message. The RPC handler classifies by `reason`, so its status codes are unchanged.
 * Input errors keep their message (it describes the caller's own input). Other errors pass through.
 */
const GENERIC: Record<string, string> = {
  [ORMErrorReason.NOT_FOUND]: 'record not found',
  [ORMErrorReason.REJECTED_BY_POLICY]: 'operation rejected by policy',
  [ORMErrorReason.DB_QUERY_ERROR]: 'database query failed',
};

function sanitizeError(error: unknown): unknown {
  if (!(error instanceof ORMError)) return error;
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

const rethrow = (error: unknown): never => {
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
function policyFacade(client: Db): PolicyDb {
  const facade: Record<string, unknown> = Object.create(null);
  for (const key of MODEL_KEYS) {
    const delegate = (client as unknown as Record<string, Record<string, AnyFn>>)[key] as Record<
      string,
      AnyFn
    >;
    const copy: Record<string, AnyFn> = Object.create(null);
    for (const name of Object.keys(delegate)) {
      copy[name] = (...args) => {
        try {
          assertPlainData(args);
        } catch (error) {
          return opaque(undefined, client, error as ORMError);
        }
        return opaque((delegate[name] as AnyFn).apply(delegate, args) as never, client);
      };
    }
    facade[key] = Object.freeze(copy);
  }
  facade.$schema = FROZEN_SCHEMA;
  facade.$transaction = (arg: unknown, options?: TransactionOptions): unknown => {
    if (typeof arg === 'function') {
      return Promise.resolve(
        (client.$transaction as AnyFn).call(
          client,
          (tx: Db) => (arg as (tx: PolicyDb) => unknown)(policyFacade(tx)),
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
