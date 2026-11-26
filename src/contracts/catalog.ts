import { z } from 'zod';
import { availability, cents } from './common.js';

export const productCard = z.strictObject({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  brand: z.strictObject({ slug: z.string(), name: z.string() }),
  category: z.string(),
  imageUrl: z.string().nullable(),
  hoverImageUrl: z.string().nullable(),
  priceCents: cents,
  compareAtCents: cents.nullable(),
  discountPct: z.number().int().nullable(),
  badges: z.array(z.string()),
  colors: z.array(z.strictObject({ name: z.string(), swatchHex: z.string().nullable() })),
  sizes: z.array(z.string()),
  availability,
  /** Only when 1–3 are left. */
  lowStockCount: z.number().int().min(1).max(3).nullable(),
});

export const productList = z.strictObject({ products: z.array(productCard), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });

const facetOption = z.strictObject({ value: z.string(), label: z.string(), count: z.number().int(), selected: z.boolean() });
export const facet = z.strictObject({
  key: z.string(),
  label: z.string(),
  type: z.enum(['checkbox', 'radio', 'range']),
  options: z.array(facetOption).optional(),
  range: z
    .strictObject({
      min: cents,
      max: cents,
      selectedMin: cents.nullable(),
      selectedMax: cents.nullable(),
      buckets: z.array(z.strictObject({ label: z.string(), min: cents, max: cents.nullable(), count: z.number().int() })),
    })
    .optional(),
});
export const filters = z.strictObject({ total: z.number().int(), facets: z.array(facet) });

export const productDetail = productCard.extend({
  shortName: z.string().nullable(),
  description: z.string().nullable(),
  highlights: z.array(z.string()),
  specs: z.record(z.string(), z.unknown()),
  attributes: z.record(z.string(), z.unknown()),
  isCustomizable: z.boolean(),
  heroTagline: z.string().nullable(),
  images: z.array(z.strictObject({ url: z.string(), alt: z.string().nullable(), colorName: z.string().nullable() })),
  variants: z.array(
    z.strictObject({
      id: z.string().uuid(),
      size: z.string(),
      color: z.string(),
      sku: z.string(),
      priceCents: cents,
      compareAtCents: cents.nullable(),
      availability,
      lowStockCount: z.number().int().nullable(),
      byBranch: z.record(z.string(), availability),
    }),
  ),
  related: z.array(productCard),
  sizeGuide: z.strictObject({ title: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.string())), note: z.string().nullable() }).nullable(),
});
export const productDetailResponse = z.strictObject({ product: productDetail });

export const printOptions = z.strictObject({
  baseCents: z.number().int(),
  patches: z.array(z.strictObject({ id: z.enum(['none', 'ucl', 'cpl', 'aff', 'champions', 'f1-paddock']), label: z.string(), feeCents: z.number().int() })),
  fonts: z.array(z.strictObject({ id: z.enum(['pro-condensed', 'classic-block', 'motorsport-aero']), label: z.string() })),
  nameMaxLength: z.number().int(),
  numberMin: z.number().int(),
  numberMax: z.number().int(),
});

export const menu = z.strictObject({
  categories: z.array(z.strictObject({ slug: z.string(), name: z.string(), productCount: z.number().int() })),
  brands: z.array(z.strictObject({ slug: z.string(), name: z.string(), productCount: z.number().int() })),
  collections: z.array(z.strictObject({ slug: z.string(), name: z.string() })),
});

/** Home sections are small CMS records: the payload is open (title, subtitle, link, imagePath, products…). */
export const home = z.strictObject({
  sections: z.array(
    z.strictObject({
      id: z.string(),
      type: z.enum(['hero', 'product_rail', 'category_grid', 'brand_row']),
      payload: z.looseObject({ title: z.string().optional(), products: z.array(productCard).optional() }),
    }),
  ),
});

export const collection = z.strictObject({ collection: z.strictObject({ slug: z.string(), name: z.string(), description: z.string().nullable() }) });

export const suggest = z.strictObject({
  products: z.array(z.strictObject({ slug: z.string(), name: z.string(), imageUrl: z.string().nullable(), priceCents: cents })),
  brands: z.array(z.strictObject({ slug: z.string(), name: z.string() })),
  categories: z.array(z.strictObject({ slug: z.string(), name: z.string() })),
});

export const branches = z.strictObject({
  branches: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      shortName: z.string(),
      address: z.string(),
      district: z.string().nullable(),
      phone: z.string().nullable(),
      telegram: z.string().nullable(),
      hours: z.string().nullable(),
      landmarks: z.string().nullable(),
      lat: z.number().nullable(),
      lng: z.number().nullable(),
      pickupEnabled: z.boolean(),
    }),
  ),
});

const geoItem = z.strictObject({ code: z.string(), nameEn: z.string(), nameKm: z.string() });
export const provinces = z.strictObject({ provinces: z.array(geoItem) });
export const districts = z.strictObject({ districts: z.array(geoItem) });
export const communes = z.strictObject({ communes: z.array(geoItem) });

export const questions = z.strictObject({
  questions: z.array(z.strictObject({ id: z.string().uuid(), authorName: z.string(), question: z.string(), answer: z.string().nullable(), answeredAt: z.string().nullable(), createdAt: z.string() })),
});
