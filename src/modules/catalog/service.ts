import type { Db } from '../../db/client.js';
import { ApiError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { findProductBySlug, listProducts, sortKey, stockBySize, type ProductRow } from './repository.js';
import { SLUG_PARAM, type ProductDetail, type ProductListQuery, type ProductSummary } from './schemas.js';

const SIZE_ORDER = [
  'XS', 'S', 'M', 'L', 'XL', 'XXL',
  'EU 39', 'EU 40', 'EU 40.5', 'EU 41', 'EU 42', 'EU 42.5', 'EU 43', 'EU 44', 'EU 44.5', 'EU 45',
  'Size 4', 'Size 5', 'Size 7', 'Size 8', 'Size 9', 'Size 10', 'Size 11',
];
const sizeRank = (size: string) => {
  const i = SIZE_ORDER.findIndex((s) => size === s || size.startsWith(`${s} `));
  return i === -1 ? SIZE_ORDER.length : i;
};

function toSummary(row: ProductRow): ProductSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    brand: row.brand,
    category: row.category,
    league: row.league,
    team: row.team,
    teamType: row.teamType,
    season: row.season,
    kitType: row.kitType,
    priceCents: row.priceCents,
    originalPriceCents: row.originalPriceCents,
    image: row.media.front,
    imageBack: row.media.back ?? null,
    versions: row.versions,
    fits: row.fits,
    sleeves: row.sleeves,
    customizable: row.customizable,
    rating: row.rating,
    reviewCount: row.reviewCount,
  };
}

export async function getProductPage(db: Db, query: ProductListQuery) {
  const after = query.cursor ? decodeCursor(query.cursor) : null;
  const rows = await listProducts(db, query, after);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor = rows.length > query.limit && last ? encodeCursor([sortKey(last, query.sort), last.slug]) : null;
  return { items: page.map(toSummary), nextCursor };
}

export async function getProductDetail(db: Db, slug: string): Promise<ProductDetail> {
  const notFound = ApiError.notFound(`No product with slug "${slug.slice(0, 120)}".`);
  if (!SLUG_PARAM.test(slug)) throw notFound;
  const row = await findProductBySlug(db, slug);
  if (!row) throw notFound;
  const sizes = (await stockBySize(db, row.id))
    .sort((a, b) => sizeRank(a.size) - sizeRank(b.size) || a.size.localeCompare(b.size))
    .map((s) => ({ size: s.size, quantity: s.quantity, inStock: s.quantity > 0 }));
  return {
    ...toSummary(row),
    shortName: row.shortName,
    summary: row.summary,
    highlights: row.highlights,
    specs: row.specs,
    facts: row.facts,
    media: row.media,
    sizes,
  };
}
