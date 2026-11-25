import { sql } from 'drizzle-orm';
import { createDb, type Database } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/db/seed/index.js';
import { TEST_DATABASE_URL } from './testConfig.js';

/** Reference data that survives resetDb(). */
const REFERENCE_TABLES = new Set([
  'branches',
  'categories',
  'geo_provinces',
  'geo_districts',
  'geo_communes',
  'settings',
  'shipping_methods',
  'shipping_rates',
]);

let shared: Promise<Database> | undefined;

/** One migrated + seeded database per test file (files run one at a time). */
export function testDb(): Promise<Database> {
  shared ??= (async () => {
    const database = createDb({ databaseUrl: TEST_DATABASE_URL, databaseSsl: false });
    await runMigrations(database.db);
    await seed(database.db);
    return database;
  })();
  return shared;
}

/** Empties every non-reference table. */
export async function resetDb(database: Database): Promise<void> {
  const result = await database.pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  );
  const tables = result.rows.map((r) => r.tablename).filter((t) => !REFERENCE_TABLES.has(t));
  if (tables.length > 0) {
    await database.db.execute(sql.raw(`truncate ${tables.map((t) => `"${t}"`).join(', ')} restart identity cascade`));
  }
}

export async function closeTestDb(): Promise<void> {
  if (shared) {
    const database = await shared;
    shared = undefined;
    await database.close();
  }
}
