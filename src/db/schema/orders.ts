import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { branches } from './branches.js';
import type { I18n } from './catalog.js';
import { variants } from './catalog.js';
import { promotions, shippingMethods } from './commerce.js';
import { users } from './users.js';

export const ORDER_STATUSES = [
  'pending_payment',
  'awaiting_pickup_payment',
  'confirmed',
  'printing',
  'ready_for_pickup',
  'out_for_delivery',
  'delivered',
  'completed',
  'cancelled',
  'expired',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_METHODS = ['aba_khqr', 'card', 'acleda', 'wing', 'cash_on_pickup'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['pending', 'approved', 'declined', 'refunded', 'expired', 'cancelled'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type OrderPaymentStatus = 'unpaid' | 'paid' | 'refunded';
export type ContactChannel = 'phone' | 'telegram' | 'whatsapp';
export type Fulfillment = 'delivery' | 'pickup';

export interface ShipAddressSnapshot {
  recipientName: string;
  phoneE164: string;
  provinceCode: string;
  provinceName: I18n;
  districtCode: string;
  districtName: I18n;
  communeCode: string;
  communeName: I18n;
  street: string;
  landmark: string | null;
  lat: number | null;
  lng: number | null;
}

export interface ProductSnapshot {
  productId: string;
  slug: string;
  name: I18n;
  brand: string;
  color: string;
  size: string;
  sku: string;
  imagePath: string | null;
  categorySlug: string;
}

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    number: text('number').notNull().unique(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    contactName: text('contact_name').notNull(),
    contactPhoneE164: text('contact_phone_e164').notNull(),
    contactEmail: text('contact_email'),
    contactChannel: text('contact_channel').$type<ContactChannel>().notNull(),
    fulfillment: text('fulfillment').$type<Fulfillment>().notNull(),
    pickupBranchId: text('pickup_branch_id').references(() => branches.id),
    shipAddress: jsonb('ship_address').$type<ShipAddressSnapshot>(),
    shippingMethodId: text('shipping_method_id').references(() => shippingMethods.id),
    status: text('status').$type<OrderStatus>().notNull(),
    paymentStatus: text('payment_status').$type<OrderPaymentStatus>().notNull().default('unpaid'),
    paymentMethod: text('payment_method').$type<PaymentMethod>().notNull(),
    needsRefund: boolean('needs_refund').notNull().default(false),
    merchandiseCents: integer('merchandise_cents').notNull(),
    discountCents: integer('discount_cents').notNull(),
    shippingCents: integer('shipping_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    khrRate: integer('khr_rate').notNull(),
    totalKhr: integer('total_khr').notNull(),
    promoCode: text('promo_code'),
    promotionId: uuid('promotion_id').references(() => promotions.id),
    pricing: jsonb('pricing').$type<Record<string, unknown>>().notNull(),
    note: text('note'),
    reservedUntil: timestamp('reserved_until', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check('orders_status_check', sql`${t.status} in (${inList(ORDER_STATUSES)})`),
    check('orders_payment_status_check', sql`${t.paymentStatus} in ('unpaid', 'paid', 'refunded')`),
    check('orders_payment_method_check', sql`${t.paymentMethod} in (${inList(PAYMENT_METHODS)})`),
    check('orders_channel_check', sql`${t.contactChannel} in ('phone', 'telegram', 'whatsapp')`),
    check('orders_fulfillment_check', sql`${t.fulfillment} in ('delivery', 'pickup')`),
    check('orders_pickup_branch_check', sql`(${t.fulfillment} = 'pickup') = (${t.pickupBranchId} is not null)`),
    check(
      'orders_money_check',
      sql`${t.merchandiseCents} >= 0 and ${t.discountCents} >= 0 and ${t.shippingCents} >= 0 and ${t.totalCents} >= 0
        and ${t.totalCents} = ${t.merchandiseCents} - ${t.discountCents} + ${t.shippingCents}`,
    ),
    index('orders_user_idx').on(t.userId, t.createdAt),
    index('orders_phone_idx').on(t.contactPhoneE164),
    index('orders_status_reserved_idx').on(t.status, t.reservedUntil),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => variants.id),
    productSnapshot: jsonb('product_snapshot').$type<ProductSnapshot>().notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    compareAtCents: integer('compare_at_cents'),
    printFeeCents: integer('print_fee_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    lineTotalCents: integer('line_total_cents').notNull(),
    qty: integer('qty').notNull(),
    customPrint: jsonb('custom_print').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('order_items_order_idx').on(t.orderId),
    check('order_items_qty_check', sql`${t.qty} between 1 and 20`),
    check(
      'order_items_total_check',
      sql`${t.discountCents} >= 0 and ${t.lineTotalCents} = (${t.unitPriceCents} + ${t.printFeeCents}) * ${t.qty} - ${t.discountCents}`,
    ),
  ],
);

export const orderItemAllocations = pgTable(
  'order_item_allocations',
  {
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'cascade' }),
    branchId: text('branch_id')
      .notNull()
      .references(() => branches.id),
    qty: integer('qty').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orderItemId, t.branchId] }), check('order_item_allocations_qty_check', sql`${t.qty} > 0`)],
);

export const orderEvents = pgTable(
  'order_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status').$type<OrderStatus>(),
    toStatus: text('to_status').$type<OrderStatus>(),
    kind: text('kind').$type<'status' | 'payment' | 'note' | 'flag'>().notNull(),
    actor: text('actor').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('order_events_order_idx').on(t.orderId, t.id)],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    provider: text('provider').notNull(),
    providerTranId: text('provider_tran_id').notNull().unique(),
    method: text('method').$type<PaymentMethod>().notNull(),
    amountCents: integer('amount_cents').notNull(),
    status: text('status').$type<PaymentStatus>().notNull(),
    instructions: jsonb('instructions').$type<Record<string, unknown>>(),
    raw: jsonb('raw'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('payments_order_attempt_idx').on(t.orderId, t.attempt),
    check('payments_status_check', sql`${t.status} in (${inList(PAYMENT_STATUSES)})`),
    check('payments_amount_check', sql`${t.amountCents} >= 0`),
  ],
);

export const paymentWebhookEvents = pgTable(
  'payment_webhook_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    signatureValid: boolean('signature_valid').notNull(),
    processingStatus: text('processing_status').$type<'received' | 'processed' | 'ignored' | 'rejected' | 'failed'>().notNull(),
    tranId: text('tran_id'),
    payload: jsonb('payload').notNull(),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('payment_webhook_events_event_idx').on(t.provider, t.eventId)],
);

export const promotionRedemptions = pgTable(
  'promotion_redemptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promotionId: uuid('promotion_id')
      .notNull()
      .references(() => promotions.id),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    orderId: uuid('order_id')
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: 'cascade' }),
    contactPhoneE164: text('contact_phone_e164').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('promotion_redemptions_promo_idx').on(t.promotionId, t.userId), index('promotion_redemptions_phone_idx').on(t.promotionId, t.contactPhoneE164)],
);

export const loyaltyLedger = pgTable(
  'loyalty_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    reason: text('reason').$type<'order_paid' | 'rma_reversal' | 'admin'>().notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('loyalty_ledger_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('loyalty_ledger_order_paid_idx').on(t.orderId, t.reason).where(sql`${t.orderId} is not null and ${t.reason} = 'order_paid'`),
    check('loyalty_ledger_reason_check', sql`${t.reason} in ('order_paid', 'rma_reversal', 'admin')`),
  ],
);

export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channel: text('channel').$type<'telegram' | 'email'>().notNull(),
    recipient: text('recipient').notNull(),
    template: text('template').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').$type<'pending' | 'sent' | 'failed' | 'skipped'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('notification_outbox_due_idx').on(t.status, t.nextAttemptAt)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code'),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] }), index('idempotency_keys_created_idx').on(t.createdAt)],
);

export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type OrderEventRow = typeof orderEvents.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
