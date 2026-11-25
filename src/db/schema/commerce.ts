import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { I18n } from './catalog.js';
import { variants } from './catalog.js';
import { geoProvinces } from './geo.js';
import { users } from './users.js';

export const shippingMethods = pgTable('shipping_methods', {
  id: text('id').primaryKey(),
  nameI18n: jsonb('name_i18n').$type<I18n>().notNull(),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

export const shippingRates = pgTable(
  'shipping_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    methodId: text('method_id')
      .notNull()
      .references(() => shippingMethods.id),
    provinceCode: text('province_code').references(() => geoProvinces.code),
    feeCents: integer('fee_cents').notNull(),
    freeOverCents: integer('free_over_cents'),
    etaI18n: jsonb('eta_i18n').$type<I18n>(),
    needsReview: boolean('needs_review').notNull().default(false),
  },
  (t) => [
    uniqueIndex('shipping_rates_method_province_idx').on(t.methodId, sql`coalesce(${t.provinceCode}, '*')`),
    check('shipping_rates_fee_check', sql`${t.feeCents} >= 0 and (${t.freeOverCents} is null or ${t.freeOverCents} >= 0)`),
  ],
);

export const PROMOTION_TYPES = ['percent', 'fixed', 'free_shipping'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];
export interface PromotionScope {
  categories?: string[];
  brands?: string[];
  methods?: string[];
}

export const promotions = pgTable(
  'promotions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').unique(),
    name: text('name').notNull(),
    type: text('type').$type<PromotionType>().notNull(),
    value: integer('value').notNull().default(0),
    minSubtotalCents: integer('min_subtotal_cents').notNull().default(0),
    scope: jsonb('scope').$type<PromotionScope>().notNull().default({}),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    maxUsesPerUser: integer('max_uses_per_user'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('promotions_type_check', sql`${t.type} in ('percent', 'fixed', 'free_shipping')`),
    check('promotions_percent_check', sql`${t.type} <> 'percent' or ${t.value} between 1 and 100`),
    check('promotions_value_check', sql`${t.value} >= 0 and ${t.minSubtotalCents} >= 0`),
  ],
);

export const loyaltyAccounts = pgTable('loyalty_accounts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  pointsBalance: integer('points_balance').notNull().default(0),
  lifetimeSpendCents: integer('lifetime_spend_cents').notNull().default(0),
  tier: text('tier').notNull().default('bronze'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const carts = pgTable(
  'carts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    guestToken: text('guest_token').unique(),
    promoCode: text('promo_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check('carts_owner_check', sql`(${t.userId} is null) <> (${t.guestToken} is null)`)],
);

export const cartItems = pgTable(
  'cart_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    qty: integer('qty').notNull(),
    customPrint: jsonb('custom_print').$type<Record<string, unknown>>(),
    printKey: text('print_key').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('cart_items_line_idx').on(t.cartId, t.variantId, t.printKey),
    check('cart_items_qty_check', sql`${t.qty} >= 1 and ${t.qty} <= 20`),
  ],
);

export type PromotionRow = typeof promotions.$inferSelect;
export type ShippingRateRow = typeof shippingRates.$inferSelect;
export type CartRow = typeof carts.$inferSelect;
export type CartItemRow = typeof cartItems.$inferSelect;
