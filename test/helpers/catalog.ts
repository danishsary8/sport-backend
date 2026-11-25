import type { Database } from '../../src/db/client.js';
import catalog from '../../src/db/seed/data/catalog.json' with { type: 'json' };
import { importCatalog, type FrontendProduct } from '../../src/modules/catalog/importer.js';
import { resetDb } from './db.js';

export const CATALOG = catalog as FrontendProduct[];

/** Fresh database with the full storefront catalog imported. */
export async function withCatalog(database: Database): Promise<void> {
  await resetDb(database);
  await importCatalog(database.db, CATALOG);
}

/** Sets on_hand (and clears reservations) for every branch of a product's variants. */
export async function setProductStock(database: Database, slug: string, onHand: number, size?: string): Promise<void> {
  await database.pool.query(
    `update stock s set on_hand = $2, reserved = 0 from variants v join products p on p.id = v.product_id
     where s.variant_id = v.id and p.slug = $1 and ($3::text is null or v.size_label = $3)`,
    [slug, onHand, size ?? null],
  );
}
