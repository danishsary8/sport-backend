import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { branches } from './branches.js';
import { products, variants } from './catalog.js';
import { orderItems, orders } from './orders.js';
import { users } from './users.js';

export const RMA_RESOLUTIONS = ['refund', 'size_exchange', 'store_credit'] as const;
export type RmaResolution = (typeof RMA_RESOLUTIONS)[number];
export type RmaStatus = 'requested' | 'approved' | 'rejected';

export const rmaRequests = pgTable(
  'rma_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: text('number').notNull().unique(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    resolution: text('resolution').$type<RmaResolution>().notNull(),
    status: text('status').$type<RmaStatus>().notNull().default('requested'),
    refundCents: integer('refund_cents').notNull().default(0),
    note: text('note'),
    decisionNote: text('decision_note'),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('rma_requests_resolution_check', sql`${t.resolution} in ('refund', 'size_exchange', 'store_credit')`),
    check('rma_requests_status_check', sql`${t.status} in ('requested', 'approved', 'rejected')`),
    check('rma_requests_refund_check', sql`${t.refundCents} >= 0`),
    index('rma_requests_user_idx').on(t.userId, t.createdAt),
    index('rma_requests_status_idx').on(t.status, t.createdAt),
    index('rma_requests_order_idx').on(t.orderId),
  ],
);

export const rmaItems = pgTable(
  'rma_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    rmaId: uuid('rma_id')
      .notNull()
      .references(() => rmaRequests.id, { onDelete: 'cascade' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id),
    qty: integer('qty').notNull(),
    reason: text('reason').notNull(),
    exchangeVariantId: uuid('exchange_variant_id').references(() => variants.id),
    exchangeBranchId: text('exchange_branch_id').references(() => branches.id),
    refundCents: integer('refund_cents').notNull().default(0),
  },
  (t) => [
    check('rma_items_qty_check', sql`${t.qty} > 0`),
    check('rma_items_refund_check', sql`${t.refundCents} >= 0`),
    index('rma_items_rma_idx').on(t.rmaId),
    index('rma_items_order_item_idx').on(t.orderItemId),
  ],
);

export type QuestionStatus = 'pending' | 'published' | 'hidden';

export const productQuestions = pgTable(
  'product_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    question: text('question').notNull(),
    answer: text('answer'),
    answeredBy: uuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    status: text('status').$type<QuestionStatus>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('product_questions_status_check', sql`${t.status} in ('pending', 'published', 'hidden')`),
    index('product_questions_product_idx').on(t.productId, t.status, t.createdAt),
  ],
);

export type RmaRequestRow = typeof rmaRequests.$inferSelect;
export type RmaItemRow = typeof rmaItems.$inferSelect;
export type ProductQuestionRow = typeof productQuestions.$inferSelect;
