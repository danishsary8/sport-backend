import { z } from 'zod';

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

export const ProductMediaSchema = z.object({
  front: z.string(),
  back: z.string().optional(),
  gallery: z.array(z.string()).optional(),
  details: z.array(z.string()).optional(),
});

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
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const SizeStockSchema = z.object({
  size: z.string(),
  quantity: z.number().int(),
  inStock: z.boolean(),
});

export const ProductDetailSchema = ProductSummarySchema.extend({
  shortName: z.string(),
  summary: z.string(),
  highlights: z.array(z.string()),
  specs: z.record(z.string(), z.string()),
  facts: z.record(z.string(), z.unknown()),
  media: ProductMediaSchema,
  sizes: z.array(SizeStockSchema),
});
export type ProductDetail = z.infer<typeof ProductDetailSchema>;

export const ProductListResponseSchema = z.object({
  items: z.array(ProductSummarySchema),
  nextCursor: z.string().nullable(),
});

export const SLUG_PARAM = /^[a-z0-9-]{1,120}$/;
