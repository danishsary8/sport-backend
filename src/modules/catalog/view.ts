import { availabilityOf, type Availability } from './availability.js';
import { pick, type Lang } from './i18n.js';
import type { ListedRow } from './listing.js';

export interface ProductCard {
  id: string;
  slug: string;
  name: string;
  brand: { slug: string; name: string };
  category: string;
  imageUrl: string | null;
  hoverImageUrl: string | null;
  priceCents: number;
  compareAtCents: number | null;
  discountPct: number | null;
  badges: string[];
  colors: { name: string; swatchHex: string | null }[];
  sizes: string[];
  availability: Availability;
  lowStockCount: number | null;
}

/** Where uploaded photos ("media/<id>.<ext>") are served: this API's public address. Set once at start-up. */
let mediaBase = '';
export function setMediaBase(publicApiUrl: string): void {
  mediaBase = publicApiUrl.replace(/\/+$/, '');
}

export function assetUrl(base: string, path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith('media/')) return `${mediaBase}/v1/${path}`;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

const BADGES: [keyof ListedRow['flags'], string][] = [
  ['newArrival', 'new'],
  ['bestSeller', 'best_seller'],
  ['limitedEdition', 'limited'],
  ['signatureEdition', 'signature'],
];

export function toCard(row: ListedRow, lang: Lang, assetBase: string): ProductCard {
  const discounted = row.compare_at !== null && row.compare_at > row.price;
  const badges = BADGES.filter(([flag]) => row.flags?.[flag]).map(([, badge]) => badge);
  if (discounted) badges.push('sale');
  return {
    id: row.id,
    slug: row.slug,
    name: pick(row.name_i18n, lang) ?? row.slug,
    brand: { slug: row.brand_slug, name: row.brand_name },
    category: row.category_slug,
    imageUrl: assetUrl(assetBase, row.images?.[0]),
    hoverImageUrl: assetUrl(assetBase, row.images?.[1]),
    priceCents: row.price,
    compareAtCents: discounted ? row.compare_at : null,
    discountPct: discounted ? row.discount_pct : null,
    badges,
    colors: row.colors ?? [],
    sizes: row.sizes ?? [],
    ...availabilityOf(row.units),
  };
}
