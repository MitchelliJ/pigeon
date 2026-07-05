/*
 * Database client module.
 *
 * Wraps porsager's `postgres.js` (the `postgres` package) in a small `Db`
 * interface: a tagged-template `query`, a `withTx` that runs `fn` inside
 * BEGIN/COMMIT (rolling back on error), and `close`. Every feature that owns
 * data mounts onto this client; no `pg` driver or env-based connection params
 * are used — one connection string, one pool (FR-1, FR-4).
 */
import postgres from "postgres";

/**
 * Loose tagged-template query signature. `postgres.js`'s `sql` overloads are
 * heavily generic; we only need "rows back", so we cast at this single
 * boundary (KISS). `withTx` reuses this same alias for its `tx` parameter.
 */
type LooseQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Array<Record<string, unknown>>>;

/**
 * A transaction client: the callable tagged-template query plus an `unsafe`
 * capability for running raw SQL text (used by the migration runner to apply a
 * `.sql` file verbatim). `postgres.js`'s `sql.begin` transaction object already
 * exposes `.unsafe`, so the runtime shape matches.
 */
type TxClient = LooseQuery & { unsafe: (text: string) => Promise<void> };

export interface Db {
  query: LooseQuery;
  withTx: <T>(fn: (tx: TxClient) => Promise<T>) => Promise<T>;
  unsafe: (text: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Build a `Db` client from a `DATABASE_URL` connection string. The underlying
 * `postgres.js` `sql` is captured by closure so `close()` can end the pool.
 */
export function createDb(connectionString: string): Db {
  const sql = postgres(connectionString);

  // postgres.js tagged templates return a thenable that resolves to a rows
  // array; we keep the typing loose (Record<string, unknown>[]) per KISS/YAGNI.
  const query: Db["query"] = (strings, ...values) =>
    (sql as unknown as LooseQuery)(strings, ...values);

  const withTx: Db["withTx"] = async <T>(fn: (tx: TxClient) => Promise<T>) =>
    // postgres.js `sql.begin` already wraps `fn` in BEGIN and issues ROLLBACK
    // on a thrown error, rethrowing to the caller.
    // TODO(feature-5): bounded retry on 40P01 (serialization/deadlock).
    sql.begin(async (tx) =>
      fn(tx as unknown as TxClient),
    ) as unknown as Promise<T>;

  // `sql.unsafe` runs raw SQL text as a single multi-statement string — used
  // by the migration runner to apply a `.sql` file's contents verbatim.
  const unsafe: Db["unsafe"] = async (text) => {
    await sql.unsafe(text);
  };

  const close: Db["close"] = async () => {
    await sql.end();
  };

  return { query, withTx, unsafe, close };
}
