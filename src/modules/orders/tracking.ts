import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { orders, type ShipAddressSnapshot } from '../../db/schema/index.js';
import type { I18n } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { pick, type Lang } from '../catalog/i18n.js';
import { assetUrl } from '../catalog/view.js';
import { loadOrderView } from './load.js';
import type { OrderView } from './view.js';

export interface MaskedAddress {
  recipient: string;
  communeName: I18n;
  districtName: I18n;
  provinceName: I18n;
}

/** 'Sok Dara' → 'Sok D.'; a single name stays as it is. */
export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)!.charAt(0).toUpperCase()}.` : (parts[0] ?? '');
}

export function maskedAddress(a: ShipAddressSnapshot | null): MaskedAddress | null {
  if (!a) return null;
  return { recipient: maskName(a.recipientName), communeName: a.communeName, districtName: a.districtName, provinceName: a.provinceName };
}

const notFound = () => new AppError('order_not_found', 404, 'We could not find an order with that number and phone');

/** Order number + phone → status and timeline, without anything that identifies or locates the customer. */
export async function trackOrder(db: Db, number: string, phoneE164: string | null, opts: { lang: Lang; assetBase: string }): Promise<{ order: Omit<OrderView, 'shipAddress' | 'contact'> & { shipAddress: MaskedAddress | null; contact: { name: string; phone: string; channel: string } } }> {
  const normalized = number.trim().toUpperCase();
  if (!/^SC-\d{4}-[0-9A-Z]{5}$/.test(normalized) || !phoneE164) throw notFound();
  const [order] = await db.select().from(orders).where(and(eq(orders.number, normalized), eq(orders.contactPhoneE164, phoneE164)));
  if (!order) throw notFound();
  const { order: view } = await loadOrderView(db, order, opts);
  return {
    order: {
      ...view,
      shipAddress: maskedAddress(order.shipAddress),
      contact: { name: maskName(order.contactName), phone: `***${phoneE164.slice(-3)}`, channel: order.contactChannel },
      note: null,
    },
  };
}

export interface OrderSummary {
  number: string;
  status: string;
  paymentStatus: string;
  fulfillment: string;
  totalCents: number;
  itemCount: number;
  firstItem: { name: string; imageUrl: string | null } | null;
  createdAt: string;
}

export async function listMemberOrders(db: Db, userId: string, page: number, pageSize: number, opts: { lang: Lang; assetBase: string }): Promise<{ orders: OrderSummary[]; total: number; page: number; pageSize: number }> {
  const [totalRow] = await db.select({ n: count() }).from(orders).where(eq(orders.userId, userId));
  const rows = await db
    .select({
      order: orders,
      itemCount: sql<number>`(select coalesce(sum(qty), 0)::int from order_items oi where oi.order_id = "orders"."id")`,
      first: sql<{ name: I18n; imagePath: string | null } | null>`(select oi.product_snapshot from order_items oi where oi.order_id = "orders"."id" order by oi.id limit 1)`,
    })
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    orders: rows.map(({ order, itemCount, first }) => ({
      number: order.number,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillment: order.fulfillment,
      totalCents: order.totalCents,
      itemCount,
      firstItem: first ? { name: pick(first.name, opts.lang) ?? '', imageUrl: assetUrl(opts.assetBase, first.imagePath) } : null,
      createdAt: order.createdAt.toISOString(),
    })),
    total: totalRow?.n ?? 0,
    page,
    pageSize,
  };
}

