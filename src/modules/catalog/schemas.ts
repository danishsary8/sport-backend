import { z } from '../../lib/zod.js';

const SLUG = /^[a-z0-9-]{1,80}$/;
const MAX_VALUES = 20;

/** Comma-separated list of slugs, e.g. "premier-league,la-liga". */
function slugList<T extends readonly [string, ...string[]]>(allowed?: T) {
  return z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return undefined;
      const values = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (values.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'Give at least one value' });
        return z.NEVER;
      }
      if (values.length > MAX_VALUES) {
        ctx.addIssue({ code: 'custom', message: `At most ${MAX_VALUES} values` });
        return z.NEVER;
      }
      for (const value of values) {
        if (allowed ? !allowed.includes(value) : !SLUG.test(value)) {
          ctx.addIssue({
            code: 'custom',
            message: allowed ? `"${value}" is not one of: ${allowed.join(', ')}` : `"${value}" is not a valid slug`,
          });
          return z.NEVER;
        }
      }
      return values;
    });
}

export const CATEGORIES = ['jerseys', 'boots', 'f1', 'balls', 'essentials'] as const;
export const KIT_TYPES = ['home', 'away', 'third', 'goalkeeper', 'special'] as const;
export const SORTS = ['featured', 'newest', 'price-asc', 'price-desc', 'rating'] as const;

export const ProductListQuerySchema = z.object({
  category: slugList(CATEGORIES),
  league: slugList(),
  team: slugList(),
  season: slugList(),
  kit: slugList(KIT_TYPES),
  brand: slugList(),
  q: z.string().trim().min(1, 'Search text cannot be empty').max(80).optional(),
  sort: z.enum(SORTS).default('featured'),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  cursor: z.string().max(500).optional(),
});
export type ProductListQuery = z.infer<typeof ProductListQuerySchema>;

export const ProductMediaSchema = z
  .object({
    front: z.string(),
    back: z.string().optional(),
    gallery: z.array(z.string()).optional(),
    details: z.array(z.string()).optional(),
  })
  .openapi('ProductMedia', { description: 'Image paths. `back` exists when a real back photo has been added.' });

export const ProductSummarySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  brand: z.string(),
  category: z.enum(CATEGORIES),
  league: z.string().nullable(),
  team: z.string().nullable(),
  teamType: z.enum(['club', 'national']).nullable(),
  season: z.string().nullable(),
  kitType: z.enum(KIT_TYPES).nullable(),
  priceCents: z.number().int(),
  originalPriceCents: z.number().int().nullable(),
  image: z.string(),
  imageBack: z.string().nullable(),
  versions: z.array(z.string()),
  fits: z.array(z.string()),
  sleeves: z.array(z.string()),
  customizable: z.boolean(),
  rating: z.number(),
  reviewCount: z.number().int(),
}).openapi('ProductSummary', {
  description: 'A product as shown in lists. Prices are integer cents (USD).',
  example: {
    id: '0193a3c4-5d6e-7f80-9a1b-2c3d4e5f6a7b',
    slug: 'real-madrid-2026-27-home-authentic-jersey',
    name: 'Real Madrid 2026/27 Home Jersey',
    brand: 'Adidas',
    category: 'jerseys',
    league: 'La Liga',
    team: 'Real Madrid',
    teamType: 'club',
    season: '2026/27',
    kitType: 'home',
    priceCents: 9800,
    originalPriceCents: null,
    image: '/src/assets/images/jersey_madrid_2627_home.jpg',
    imageBack: null,
    versions: ['Fan', 'Player'],
    fits: ['Men', 'Women', 'Kids'],
    sleeves: ['Short', 'Long'],
    customizable: true,
    rating: 4.9,
    reviewCount: 214,
  },
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const SizeStockSchema = z
  .object({
    size: z.string(),
    quantity: z.number().int().openapi({ description: 'Units across all three branches' }),
    inStock: z.boolean(),
  })
  .openapi('SizeStock');

export const ProductDetailSchema = ProductSummarySchema.extend({
  shortName: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()),
  specs: z.record(z.string(), z.string()),
  facts: z.record(z.string(), z.unknown()),
  media: ProductMediaSchema,
  sizes: z.array(SizeStockSchema),
}).openapi('ProductDetail');
export type ProductDetail = z.infer<typeof ProductDetailSchema>;

export const ProductListResponseSchema = z
  .object({
    items: z.array(ProductSummarySchema),
    nextCursor: z.string().nullable().openapi({ description: 'Pass as `cursor` to get the next page; null on the last page.' }),
  })
  .openapi('ProductList');

const listParam = (description: string, example: string) =>
  z.string().optional().openapi({ description: `${description} Comma-separated; values combine with OR.`, example });

/** Documentation view of the list query (the validating schema above uses transforms). */
export const ProductListQueryDocSchema = z.object({
  category: listParam(`One of ${CATEGORIES.join(', ')}.`, 'jerseys'),
  league: listParam('League slug.', 'premier-league,la-liga'),
  team: listParam('Team slug.', 'real-madrid'),
  season: listParam('Season slug, or `retro`.', '2026-27'),
  kit: listParam(`One of ${KIT_TYPES.join(', ')}.`, 'home'),
  brand: listParam('Brand slug.', 'adidas'),
  q: z.string().optional().openapi({ description: 'Search in name, team and brand (1–80 characters).', example: 'madrid' }),
  sort: z.enum(SORTS).optional().openapi({ description: 'Default `featured`.' }),
  limit: z.number().int().min(1).max(60).optional().openapi({ description: 'Page size, 1–60. Default 24.' }),
  cursor: z.string().optional().openapi({ description: '`nextCursor` from the previous page.' }),
});

export const SLUG_PARAM = /^[a-z0-9-]{1,120}$/;
