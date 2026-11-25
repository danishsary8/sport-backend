import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

/** Creates a connection pool and a typed Drizzle client. Fails fast (2 s) when Postgres is unreachable. */
export function createDb(url: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30_000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', () => {});
  return { db: drizzle(pool, { schema }), pool };
}
