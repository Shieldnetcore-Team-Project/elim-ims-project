import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

const { Pool } = pg;

// Postgres returns COUNT(*) (and any bigint/int8 column) as a string, since it
// doesn't fit safely in a JS number in general — unlike the old node:sqlite
// driver, which always handed back real numbers. Every count in this app is
// well within Number.MAX_SAFE_INTEGER, and callers throughout the codebase
// (e.g. userCount() === 0, pendingCounts.ts summing several counts) already
// assume a real number, so parse int8 as one globally rather than special-casing
// every call site.
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL environment variable is required');

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

// Threads the single pooled client checked out by db.transaction() through every
// nested db.prepare(...) call made inside its callback, so a multi-statement business
// transaction (e.g. sales.approveCreditSale) shares one real Postgres transaction
// instead of each query grabbing its own connection from the pool.
const txContext = new AsyncLocalStorage<pg.PoolClient>();

function executor(): Pick<pg.Pool | pg.PoolClient, 'query'> {
  return txContext.getStore() ?? pool;
}

/** node:sqlite (better-sqlite3-style) uses positional `?` placeholders; pg needs
 *  numbered `$1,$2,...`. Rewritten here, quote-aware, so none of the SQL text at any
 *  of the ~490 call sites across the app needs to change — only the JS call site gets
 *  `await` added. No SQL string in this codebase contains a literal `?` inside a
 *  string/identifier, but this stays quote-aware defensively rather than assuming that. */
function toPositional(sql: string): string {
  let out = '';
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === '?' && !inSingle && !inDouble) {
      n += 1;
      out += `$${n}`;
    } else {
      out += c;
    }
  }
  return out;
}

export interface RunResult { changes: number }

interface PreparedLike<Row> {
  get(...params: unknown[]): Promise<Row | undefined>;
  all(...params: unknown[]): Promise<Row[]>;
  run(...params: unknown[]): Promise<RunResult>;
}

function prepare<Row = Record<string, unknown>>(sql: string): PreparedLike<Row> {
  const text = toPositional(sql);
  return {
    async get(...params) {
      const res = await executor().query(text, params);
      return res.rows[0] as Row | undefined;
    },
    async all(...params) {
      const res = await executor().query(text, params);
      return res.rows as Row[];
    },
    async run(...params) {
      const res = await executor().query(text, params);
      return { changes: res.rowCount ?? 0 };
    },
  };
}

async function exec(sql: string): Promise<void> {
  await executor().query(sql);
}

/** Replaces the old db.exec('BEGIN') / db.exec('COMMIT') / db.exec('ROLLBACK') pattern.
 *  Every db.prepare(...) call made inside `fn` (directly or through nested service
 *  calls) transparently reuses the same checked-out connection via txContext. */
async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txContext.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const db = { prepare, exec, transaction };
