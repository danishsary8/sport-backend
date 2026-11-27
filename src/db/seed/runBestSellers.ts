import 'dotenv/config';
import { loadConfig } from '../../config/env.js';
import { createDb } from '../client.js';
import { seedBestSellers } from './bestSellers.js';

const database = createDb(loadConfig(process.env));
try {
  console.log('Starting best sellers', await seedBestSellers(database.db));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.close();
}
