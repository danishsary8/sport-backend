import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { products } from '../src/db/schema.js';
import { loadCatalogFile, seedCatalog } from '../src/db/seed.js';
import { buildTestApp, resetDb } from './setup/test-app.js';

const { db, pool } = buildTestApp();
const catalog = loadCatalogFile();
afterAll(() => pool.end());
beforeEach(() => resetDb(db));

const count = async () => (await db.execute(sql`select count(*)::int as n from products`)).rows[0]!.n;

describe('seedCatalog', () => {
  it('seeds all 80 products with stock', async () => {
    const result = await seedCatalog(db, catalog);
    expect(result.products).toBe(80);
    expect(result.stockRows).toBeGreaterThan(0);
  });

  it('is idempotent: seeding twice keeps 80 products', async () => {
    await seedCatalog(db, catalog);
    await seedCatalog(db, catalog);
    expect(await count()).toBe(80);
  });

  it('stores money in cents', async () => {
    await seedCatalog(db, catalog);
    const [row] = await db.select().from(products).where(eq(products.slug, 'real-madrid-2026-27-home-authentic-jersey'));
    expect(row?.priceCents).toBe(9800);
  });

  it('marks retro kits with season_slug "retro"', async () => {
    await seedCatalog(db, catalog);
    const [row] = await db.select().from(products).where(eq(products.slug, 'fc-barcelona-1998-99-centenary-retro-jersey'));
    expect(row?.seasonSlug).toBe('retro');
    expect(row?.kitType).toBe('home');
  });

  it('rejects a malformed seed item with the slug in the message', async () => {
    const bad = [{ ...catalog[0]!, price: -1 }];
    await expect(seedCatalog(db, bad)).rejects.toThrow(new RegExp(catalog[0]!.slug));
    expect(await count()).toBe(0);
  });
});
