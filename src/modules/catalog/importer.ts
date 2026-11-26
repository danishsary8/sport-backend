import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  branches,
  brands,
  categories,
  productColors,
  productImages,
  products,
  stock,
  stockMovements,
  variants,
  type ProductAttributes,
  type ProductFlags,
} from '../../db/schema/index.js';
import { sizeSort } from './sizes.js';
import { skuBase } from './sku.js';
import { buildSearchText, slugify } from './searchText.js';

/** The subset of the storefront's Product type the importer reads. */
export interface FrontendProduct {
  slug: string;
  name: string;
  shortName?: string;
  brand: string;
  category: string;
  price: number;
  originalPrice?: number;
  colorway: string;
  swatchHex?: string;
  sizes: string[];
  image: string;
  summary?: string;
  techHighlights?: string[];
  specs?: Record<string, string>;
  branchStock: Record<string, 'In Stock' | 'Limited Stock' | 'Out of Stock'>;
  customizable?: boolean;
  heroTagline?: string;
  surface?: string;
  weightGrams?: number;
  league?: string;
  club?: string;
  season?: string;
  nationalRegion?: string;
  kitType?: string;
  garmentType?: string;
  isChampionsLeague?: boolean;
  isRetro?: boolean;
  jerseyTheme?: Record<string, string>;
  isFeatured?: boolean;
  isBestSeller?: boolean;
  isNewArrival?: boolean;
  isLimitedEdition?: boolean;
  isSignatureEdition?: boolean;
  isHeroSpotlight?: boolean;
}

/** Starting counts for the storefront's stock labels; flagged so staff count the real stock. */
export const STOCK_LEVEL_UNITS: Record<string, number> = { 'In Stock': 10, 'Limited Stock': 2, 'Out of Stock': 0 };

const toCents = (usd: number) => Math.round(usd * 100);


function attributesOf(p: FrontendProduct): ProductAttributes {
  const a: ProductAttributes = {
    league: p.league,
    club: p.club,
    season: p.season,
    kitType: p.kitType,
    nationalRegion: p.nationalRegion,
    surface: p.surface,
    garmentType: p.garmentType,
    isChampionsLeague: p.isChampionsLeague,
    isRetro: p.isRetro,
    weightGrams: p.weightGrams,
    jerseyTheme: p.jerseyTheme,
  };
  return Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as ProductAttributes;
}

function flagsOf(p: FrontendProduct): ProductFlags {
  return {
    featured: p.isFeatured === true,
    bestSeller: p.isBestSeller === true,
    newArrival: p.isNewArrival === true,
    limitedEdition: p.isLimitedEdition === true,
    signatureEdition: p.isSignatureEdition === true,
    heroSpotlight: p.isHeroSpotlight === true,
  };
}

/**
 * Adds storefront products that aren't in the database yet (matched by slug). Products that
 * already exist are skipped entirely, so re-running never reverts admin edits to names, prices
 * or stock. Use the admin API to change existing products.
 */
export async function importCatalog(
  db: Db,
  input: FrontendProduct[],
): Promise<{ products: number; variants: number; created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;
  let variantCount = 0;

  await db.transaction(async (tx) => {
    const branchIds = (await tx.select({ id: branches.id }).from(branches)).map((b) => b.id);
    const categoryIds = new Map((await tx.select().from(categories)).map((c) => [c.slug, c.id]));
    const usedSkus = new Set((await tx.select({ sku: variants.sku }).from(variants)).map((v) => v.sku));

    for (const p of input) {
      const [existingProduct] = await tx.select({ id: products.id }).from(products).where(eq(products.slug, p.slug));
      if (existingProduct) {
        skipped += 1;
        continue;
      }

      const categoryId = categoryIds.get(p.category);
      if (!categoryId) throw new Error(`Unknown category "${p.category}" for ${p.slug}`);

      const [brand] = await tx
        .insert(brands)
        .values({ slug: slugify(p.brand), name: p.brand })
        .onConflictDoUpdate({ target: brands.slug, set: { name: sql`excluded.name` } })
        .returning({ id: brands.id });

      const values = {
        slug: p.slug,
        brandId: brand!.id,
        categoryId,
        nameI18n: { en: p.name },
        shortNameI18n: p.shortName ? { en: p.shortName } : null,
        descriptionI18n: p.summary ? { en: p.summary } : null,
        highlights: p.techHighlights ?? [],
        specs: p.specs ?? {},
        attributes: attributesOf(p),
        isCustomizable: p.customizable === true,
        flags: flagsOf(p),
        heroTagline: p.heroTagline ?? null,
        status: 'active' as const,
        searchText: buildSearchText([p.name, p.shortName, p.brand, p.club, p.league, p.colorway, p.category]),
      };
      const [product] = await tx.insert(products).values(values).returning({ id: products.id });
      created += 1;
      const productId = product!.id;

      let [color] = await tx
        .select({ id: productColors.id })
        .from(productColors)
        .where(and(eq(productColors.productId, productId), eq(productColors.name, p.colorway)));
      if (!color) {
        [color] = await tx
          .insert(productColors)
          .values({ productId, name: p.colorway, swatchHex: p.swatchHex ?? null })
          .returning({ id: productColors.id });
      }

      // The storefront's image pipeline publishes every photo as catalog/<name>.jpg (plus AVIF/WebP sizes).
      const imagePath = `catalog/${path.basename(p.image).replace(/\.(png|jpe?g)$/i, '')}.jpg`;
      const [image] = await tx
        .select({ id: productImages.id })
        .from(productImages)
        .where(and(eq(productImages.productId, productId), eq(productImages.path, imagePath)));
      if (!image) {
        await tx.insert(productImages).values({ productId, colorId: color!.id, path: imagePath, alt: p.name });
      }

      const priceCents = toCents(p.price);
      const compareAtCents = p.originalPrice && p.originalPrice > p.price ? toCents(p.originalPrice) : null;

      for (const [position, size] of p.sizes.entries()) {
        variantCount += 1;
        const [existing] = await tx
          .select({ id: variants.id })
          .from(variants)
          .where(and(eq(variants.productId, productId), eq(variants.colorId, color!.id), eq(variants.sizeLabel, size)));
        if (existing) {
          await tx.update(variants).set({ priceCents, compareAtCents, sizeSort: sizeSort(size, position) }).where(eq(variants.id, existing.id));
          continue;
        }

        let sku = skuBase(p.slug, size);
        for (let n = 2; usedSkus.has(sku); n += 1) sku = `${skuBase(p.slug, size)}-${n}`;
        usedSkus.add(sku);

        const [variant] = await tx
          .insert(variants)
          .values({ productId, colorId: color!.id, sizeLabel: size, sizeSort: sizeSort(size, position), sku, priceCents, compareAtCents })
          .returning({ id: variants.id });

        for (const branchId of branchIds) {
          const onHand = STOCK_LEVEL_UNITS[p.branchStock[branchId] ?? 'Out of Stock'] ?? 0;
          await tx.insert(stock).values({ variantId: variant!.id, branchId, onHand, needsCount: true });
          if (onHand > 0) {
            await tx.insert(stockMovements).values({
              variantId: variant!.id,
              branchId,
              deltaOnHand: onHand,
              reason: 'import',
              note: `Starting count from storefront label "${p.branchStock[branchId]}"; needs a real count`,
            });
          }
        }
      }
    }
  });

  return { products: input.length, variants: variantCount, created, skipped };
}
