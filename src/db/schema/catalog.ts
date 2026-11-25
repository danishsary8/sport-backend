import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export type I18n = { en: string; km?: string };

export interface ProductAttributes {
  league?: string;
  club?: string;
  season?: string;
  kitType?: string;
  nationalRegion?: string;
  surface?: string;
  garmentType?: string;
  isChampionsLeague?: boolean;
  isRetro?: boolean;
  weightGrams?: number;
  jerseyTheme?: Record<string, string>;
}

export interface ProductFlags {
  featured?: boolean;
  bestSeller?: boolean;
  newArrival?: boolean;
  limitedEdition?: boolean;
  signatureEdition?: boolean;
  heroSpotlight?: boolean;
}

export const PRODUCT_STATUSES = ['draft', 'active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  logoPath: text('logo_path'),
  sort: integer('sort').notNull().default(0),
});

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  parentId: uuid('parent_id').references((): AnyPgColumn => categories.id),
  nameI18n: jsonb('name_i18n').$type<I18n>().notNull(),
  sort: integer('sort').notNull().default(0),
});

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id),
    nameI18n: jsonb('name_i18n').$type<I18n>().notNull(),
    shortNameI18n: jsonb('short_name_i18n').$type<I18n>(),
    descriptionI18n: jsonb('description_i18n').$type<I18n>(),
    highlights: jsonb('highlights').$type<string[]>().notNull().default([]),
    specs: jsonb('specs').$type<Record<string, string>>().notNull().default({}),
    attributes: jsonb('attributes').$type<ProductAttributes>().notNull().default({}),
    isCustomizable: boolean('is_customizable').notNull().default(false),
    flags: jsonb('flags').$type<ProductFlags>().notNull().default({}),
    heroTagline: text('hero_tagline'),
    status: text('status').$type<ProductStatus>().notNull().default('draft'),
    searchText: text('search_text').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('products_category_idx').on(t.categoryId),
    index('products_brand_idx').on(t.brandId),
    index('products_status_idx').on(t.status),
    index('products_search_trgm_idx').using('gin', sql`${t.searchText} gin_trgm_ops`),
    check('products_status_check', sql`${t.status} in ('draft', 'active', 'archived')`),
  ],
);

export const productColors = pgTable('product_colors', {
  id: uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id')
    .notNull()
    .references(() => products.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  swatchHex: text('swatch_hex'),
  sort: integer('sort').notNull().default(0),
});

export const productImages = pgTable(
  'product_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    colorId: uuid('color_id').references(() => productColors.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    alt: text('alt'),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [index('product_images_product_idx').on(t.productId)],
);

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    colorId: uuid('color_id')
      .notNull()
      .references(() => productColors.id),
    sizeLabel: text('size_label').notNull(),
    sizeSort: integer('size_sort').notNull(),
    sku: text('sku').notNull().unique(),
    priceCents: integer('price_cents').notNull(),
    compareAtCents: integer('compare_at_cents'),
    status: text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  },
  (t) => [
    index('variants_product_idx').on(t.productId),
    uniqueIndex('variants_product_color_size_idx').on(t.productId, t.colorId, t.sizeLabel),
    check('variants_price_check', sql`${t.priceCents} >= 0`),
    check('variants_compare_at_check', sql`${t.compareAtCents} is null or ${t.compareAtCents} > ${t.priceCents}`),
    check('variants_status_check', sql`${t.status} in ('active', 'inactive')`),
  ],
);

export type BrandRow = typeof brands.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type VariantRow = typeof variants.$inferSelect;
