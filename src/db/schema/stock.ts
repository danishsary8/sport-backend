import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { branches } from './branches.js';
import { variants } from './catalog.js';
import { users } from './users.js';

/** Units per variant per branch. available online = on_hand - reserved - buffer (never below 0). */
export const stock = pgTable(
  'stock',
  {
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => branches.id),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    onlineBuffer: integer('online_buffer'),
    needsCount: boolean('needs_count').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.branchId] }),
    check('stock_on_hand_check', sql`${t.onHand} >= 0`),
    check('stock_reserved_check', sql`${t.reserved} >= 0 and ${t.reserved} <= ${t.onHand}`),
    check('stock_buffer_check', sql`${t.onlineBuffer} is null or ${t.onlineBuffer} >= 0`),
  ],
);

/** Append-only audit trail: every stock change has exactly one row here. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id, { onDelete: 'cascade' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => branches.id),
    deltaOnHand: integer('delta_on_hand').notNull(),
    deltaReserved: integer('delta_reserved').notNull().default(0),
    reason: text('reason').notNull(),
    refId: text('ref_id'),
    note: text('note'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('stock_movements_variant_idx').on(t.variantId, t.createdAt)],
);

export type StockRow = typeof stock.$inferSelect;
