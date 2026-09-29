import postgres from "postgres";

// One client per server instance, created on first use (so `next build`
// doesn't need database credentials). prepare:false because Supabase's
// transaction pooler (port 6543, the right choice for serverless) does not
// support prepared statements.
const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

export function db(): postgres.Sql {
  if (globalForDb.sql) return globalForDb.sql;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  globalForDb.sql = postgres(url, {
    prepare: false,
    max: 5, // an issue page runs ~8 small queries at once; 3 made them queue
    idle_timeout: 20,
    connect_timeout: 15,
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
