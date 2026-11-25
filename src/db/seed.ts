import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { slugify } from '../lib/slug.js';
import { createDb, type Db } from './client.js';
import { productStock, products } from './schema.js';

const Branch = z.enum(['sonthormuk', 'sensok', 'chomkadong']);

export const CatalogSeedItemSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  shortName: z.string().min(1),
  brand: z.string().min(1),
  category: z.enum(['jerseys', 'boots', 'f1', 'balls', 'essentials']),
  league: z.string().nullish(),
  team: z.string().nullish(),
  teamType: z.enum(['club', 'national']).nullish(),
  season: z.string().nullish(),
  isRetro: z.boolean(),
  kitType: z.enum(['Home', 'Away', 'Third', 'Goalkeeper', 'Special']).nullish(),
  versions: z.array(z.string()),
  fits: z.array(z.string()),
  sleeves: z.array(z.string()),
  price: z.number().positive(),
  originalPrice: z.number().positive().nullish(),
  customizable: z.boolean(),
  rating: z.number().min(0).max(5),
  reviewCount: z.number().int().min(0),
  isFeatured: z.boolean(),
  isBestSeller: z.boolean().optional(),
  isNewArrival: z.boolean(),
  summary: z.string(),
  highlights: z.array(z.string()),
  specs: z.record(z.string(), z.string()),
  facts: z.record(z.string(), z.unknown()),
  media: z.object({
    front: z.string().min(1),
    back: z.string().optional(),
    gallery: z.array(z.string()).optional(),
    details: z.array(z.string()).optional(),
  }),
  stock: z.array(z.object({ branch: Branch, size: z.string().min(1), quantity: z.number().int().min(0) })),
});
export type CatalogSeedItem = z.infer<typeof CatalogSeedItemSchema>;

const DEFAULT_CATALOG = fileURLToPath(new URL('./seed/catalog.json', import.meta.url));

export function loadCatalogFile(path = DEFAULT_CATALOG): CatalogSeedItem[] {
  return JSON.parse(readFileSync(path, 'utf8')) as CatalogSeedItem[];
}

const cents = (usd: number) => Math.round(usd * 100);

function releasedAt(item: CatalogSeedItem): string {
  if (item.isRetro) return '2025-01-01';
  return item.isNewArrival ? '2026-08-01' : '2026-06-01';
}

/** Validates every item first, then upserts products and replaces their stock in one transaction. */
export async function seedCatalog(db: Db, items: unknown[]): Promise<{ products: number; stockRows: number }> {
  const valid: CatalogSeedItem[] = items.map((raw, i) => {
    const parsed = CatalogSeedItemSchema.safeParse(raw);
    if (!parsed.success) {
      const slug = (raw as { slug?: string })?.slug ?? `item ${i}`;
      const where = parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
      throw new Error(`Invalid catalog item "${slug}": ${where}`);
    }
    return parsed.data;
  });

  // Stable "featured" order: featured, then best sellers, then catalog order.
  const ranked = valid
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        Number(b.item.isFeatured) - Number(a.item.isFeatured) ||
        Number(Boolean(b.item.isBestSeller)) - Number(Boolean(a.item.isBestSeller)) ||
        a.index - b.index,
    );
  const rankBySlug = new Map(ranked.map(({ item }, rank) => [item.slug, rank]));

  return db.transaction(async (tx) => {
    let stockRows = 0;
    for (const item of valid) {
      const values = {
        slug: item.slug,
        name: item.name,
        shortName: item.shortName,
        brand: item.brand,
        brandSlug: slugify(item.brand),
        category: item.category,
        league: item.league ?? null,
        leagueSlug: item.league ? slugify(item.league) : null,
        team: item.team ?? null,
        teamSlug: item.team ? slugify(item.team) : null,
        teamType: item.teamType ?? null,
        season: item.season ?? null,
        seasonSlug: item.isRetro ? 'retro' : item.season ? slugify(item.season) : null,
        kitType: item.kitType ? (item.kitType.toLowerCase() as 'home') : null,
        versions: item.versions,
        fits: item.fits,
        sleeves: item.sleeves,
        priceCents: cents(item.price),
        originalPriceCents: item.originalPrice ? cents(item.originalPrice) : null,
        customizable: item.customizable,
        rating: item.rating,
        reviewCount: item.reviewCount,
        featuredRank: rankBySlug.get(item.slug) ?? 0,
        releasedAt: releasedAt(item),
        summary: item.summary,
        highlights: item.highlights,
        specs: item.specs,
        facts: item.facts,
        media: item.media,
        updatedAt: new Date(),
      };
      const [row] = await tx
        .insert(products)
        .values(values)
        .onConflictDoUpdate({ target: products.slug, set: values })
        .returning({ id: products.id });
      const productId = row!.id;
      await tx.delete(productStock).where(inArray(productStock.productId, [productId]));
      if (item.stock.length) {
        await tx.insert(productStock).values(item.stock.map((s) => ({ productId, ...s })));
        stockRows += item.stock.length;
      }
    }
    return { products: valid.length, stockRows };
  });
}

// CLI: npm run db:seed
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const { db, pool } = createDb(url);
  try {
    const result = await seedCatalog(db, loadCatalogFile());
    console.log(`Seeded ${result.products} products and ${result.stockRows} stock rows`);
  } finally {
    await pool.end();
  }
}
