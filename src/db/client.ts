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

export interface PoolOptions {
  /** Client- and server-side limit for one query; stuck queries free their connection after this. */
  queryTimeoutMs?: number;
  maxConnections?: number;
}

/** TLS settings for the pool: verified certificates always; a pinned CA when one is configured. */
export function sslOptions(cfg: Pick<Config, 'databaseSsl' | 'databaseSslCa'>): { rejectUnauthorized: true; ca?: string } | undefined {
  if (!cfg.databaseSsl) return undefined;
  return cfg.databaseSslCa ? { rejectUnauthorized: true, ca: cfg.databaseSslCa } : { rejectUnauthorized: true };
}

export function createDb(
  cfg: Pick<Config, 'databaseUrl' | 'databaseSsl'> & { databaseSslCa?: string },
  onPoolError: (err: Error) => void = () => {},
  options: PoolOptions = {},
): Database {
  const queryTimeoutMs = options.queryTimeoutMs ?? 10_000;
  const pool = new pg.Pool({
    connectionString: cfg.databaseUrl,
    ssl: sslOptions({ databaseSsl: cfg.databaseSsl, databaseSslCa: cfg.databaseSslCa }),
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: PING_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    // Without these, a half-open socket (failover, network drop) keeps a query - and its
    // connection - checked out forever, and the pool never recovers.
    query_timeout: queryTimeoutMs,
    statement_timeout: queryTimeoutMs,
    keepAlive: true,
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
