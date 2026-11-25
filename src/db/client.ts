import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Config } from '../config/env.js';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  db: Db;
  pool: pg.Pool;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const PING_TIMEOUT_MS = 3000;

export function createDb(
  cfg: Pick<Config, 'databaseUrl' | 'databaseSsl'>,
  onPoolError: (err: Error) => void = () => {},
): Database {
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    ssl: cfg.databaseSsl ? { rejectUnauthorized: true } : undefined,
    max: 10,
    connectionTimeoutMillis: PING_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
  });
  // An idle client dying (DB restart, network blip) must never crash the process.
  pool.on('error', onPoolError);

  return {
    db: drizzle(pool, { schema }),
    pool,
    async ping() {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Database ping timed out')), PING_TIMEOUT_MS);
      });
      try {
        await Promise.race([pool.query('select 1'), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
