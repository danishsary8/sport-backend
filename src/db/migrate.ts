import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config/env.js';
import { createDb, type Db } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/db (tsx, tests) and dist/db (compiled): migrations live at the repo root.
export const MIGRATIONS_FOLDER = path.resolve(here, '../../drizzle');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const database = createDb(config);
  try {
    await runMigrations(database.db);
    console.log('Migrations applied');
  } finally {
    await database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
