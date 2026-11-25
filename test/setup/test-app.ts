import { sql } from 'drizzle-orm';
import { createApp, type AppDeps } from '../../src/app.js';
import { createDb, type Db } from '../../src/db/client.js';
import { silentLogger, testConfig } from './silent.js';

/** Builds the app against the test database. Overrides replace any dependency. */
export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  const { db, pool } = createDb(testConfig.databaseUrl);
  const app = createApp({ config: testConfig, logger: silentLogger, db, ...overrides });
  return { app, db, pool };
}

/** Empties every table, keeping the schema. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`truncate table product_stock, products restart identity cascade`);
}
