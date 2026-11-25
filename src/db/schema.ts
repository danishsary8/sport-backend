import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const categoryEnum = pgEnum('product_category', ['jerseys', 'boots', 'f1', 'balls', 'essentials']);
export const teamTypeEnum = pgEnum('team_type', ['club', 'national']);
export const kitTypeEnum = pgEnum('kit_type', ['home', 'away', 'third', 'goalkeeper', 'special']);
export const branchEnum = pgEnum('branch', ['sonthormuk', 'sensok', 'chomkadong']);

export interface ProductMedia {
  front: string;
  back?: string;
  gallery?: string[];
  details?: string[];
}

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    shortName: text('short_name').notNull(),
    brand: text('brand').notNull(),
    brandSlug: text('brand_slug').notNull(),
    category: categoryEnum('category').notNull(),
    league: text('league'),
    leagueSlug: text('league_slug'),
    team: text('team'),
    teamSlug: text('team_slug'),
    teamType: teamTypeEnum('team_type'),
    season: text('season'),
    seasonSlug: text('season_slug'),
    kitType: kitTypeEnum('kit_type'),
    versions: text('versions').array().notNull().default(sql`'{}'::text[]`),
    fits: text('fits').array().notNull().default(sql`'{}'::text[]`),
    sleeves: text('sleeves').array().notNull().default(sql`'{}'::text[]`),
    priceCents: integer('price_cents').notNull(),
    originalPriceCents: integer('original_price_cents'),
    customizable: boolean('customizable').notNull().default(false),
    rating: numeric('rating', { precision: 2, scale: 1, mode: 'number' }).notNull().default(0),
    reviewCount: integer('review_count').notNull().default(0),
    featuredRank: integer('featured_rank').notNull().default(0),
    releasedAt: date('released_at', { mode: 'string' }).notNull().default(sql`current_date`),
    summary: text('summary').notNull().default(''),
    highlights: text('highlights').array().notNull().default(sql`'{}'::text[]`),
    specs: jsonb('specs').$type<Record<string, string>>().notNull().default({}),
    facts: jsonb('facts').$type<Record<string, unknown>>().notNull().default({}),
    media: jsonb('media').$type<ProductMedia>().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('products_price_positive', sql`${t.priceCents} > 0`),
    check('products_original_above_price', sql`${t.originalPriceCents} is null or ${t.originalPriceCents} > ${t.priceCents}`),
    check('products_rating_range', sql`${t.rating} between 0 and 5`),
    index('products_category_rank_idx').on(t.category, t.featuredRank),
    index('products_league_idx').on(t.leagueSlug),
    index('products_team_idx').on(t.teamSlug),
    index('products_brand_idx').on(t.brandSlug),
    index('products_price_idx').on(t.priceCents),
  ],
);

export const productStock = pgTable(
  'product_stock',
  {
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    branch: branchEnum('branch').notNull(),
    size: text('size').notNull(),
    quantity: integer('quantity').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.branch, t.size] }),
    check('product_stock_quantity_non_negative', sql`${t.quantity} >= 0`),
  ],
);
