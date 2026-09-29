import postgres from "postgres";

// One client per server instance, created on first use (so `next build`
// doesn't need database credentials). prepare:false because Supabase's
// transaction pooler (port 6543, the right choice for serverless) does not
// support prepared statements.
//
// Two defences against a page that never finishes loading:
// - max_pipeline: 0 - each connection carries one query at a time. By default
//   postgres.js queues extra queries behind a busy one on the same socket
//   ("pipelining"); through the transaction pooler a lost reply there leaves
//   every query behind it waiting forever. Nothing here uses sql.begin(),
//   which needs pipelining.
// - within(): page loaders give up after a few seconds instead of hanging
//   until Vercel kills the function at 300s, and throw away the client so the
//   next request starts on fresh connections rather than stuck ones.
const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

export function db(): postgres.Sql {
  if (globalForDb.sql) return globalForDb.sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  globalForDb.sql = postgres(url, {
    prepare: false,
    max: 8, // an issue page runs ~12 small queries at once
    ...({ max_pipeline: 0 } as object), // supported, just missing from the type definitions
    idle_timeout: 20,
    max_lifetime: 60 * 10,
    connect_timeout: 10,
    // numeric -> JS number. Every numeric here is a price, a percentage or a
    // multiple, well inside double precision.
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
  return globalForDb.sql;
}

/** Drop the current client: its connections close in the background and the
 *  next db() call opens new ones. */
export function recycle() {
  const old = globalForDb.sql;
  globalForDb.sql = undefined;
  old?.end({ timeout: 1 }).catch(() => undefined);
}

export class DbTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`${what}: no answer from the database in ${ms / 1000}s`);
    this.name = "DbTimeout";
  }
}

/** Resolve p, or fail after ms and recycle the client (a query that slow
 *  here means a stuck connection, not a slow query - they all take ~50ms). */
export async function within<T>(p: PromiseLike<T>, ms = 8000, what = "query"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      recycle();
      reject(new DbTimeout(what, ms));
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve(p), late]);
  } finally {
    clearTimeout(timer);
  }
}
