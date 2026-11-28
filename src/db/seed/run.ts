import 'dotenv/config';
import { loadConfig } from '../../config/env.js';
import { createDb } from '../client.js';
import { applyDataFixes } from '../fixes/index.js';
import { seed } from './index.js';

const config = loadConfig(process.env);
const database = createDb(config);
try {
  const counts = await seed(database.db);
  console.log('Seeded', counts);
  // One-time corrections to live data (each runs once, recorded in settings).
  console.log('Data fixes', await applyDataFixes(database.db));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.close();
}
