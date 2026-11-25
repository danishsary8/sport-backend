import 'dotenv/config';
import { loadConfig } from '../../config/env.js';
import { importCatalog, type FrontendProduct } from '../../modules/catalog/importer.js';
import { createDb } from '../client.js';
import catalog from './data/catalog.json' with { type: 'json' };

const database = createDb(loadConfig(process.env));
try {
  console.log('Imported', await importCatalog(database.db, catalog as FrontendProduct[]));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.close();
}
