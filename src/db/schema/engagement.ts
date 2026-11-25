import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { products, type I18n } from './catalog.js';
import { users } from './users.js';

export const wishlistItems = pgTable(
  'wishlist_items',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.productId] })],
);

/** A collection is a saved listing filter (same shape as the catalog query params). */
export const collections = pgTable('collections', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  nameI18n: jsonb('name_i18n').$type<I18n>().notNull(),
  descriptionI18n: jsonb('description_i18n').$type<I18n>(),
  rule: jsonb('rule').$type<Record<string, unknown>>().notNull().default({}),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
});

export const HOME_SECTION_TYPES = ['hero', 'product_rail', 'category_grid', 'brand_row'] as const;

export const homeSections = pgTable('home_sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').$type<(typeof HOME_SECTION_TYPES)[number]>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
});
