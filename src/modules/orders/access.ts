import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { orders, type OrderRow, type UserRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { verifyOrderToken } from '../checkout/orderToken.js';

const notFound = () => new AppError('order_not_found', 404, 'Order not found');

/**
 * The order, if this caller may see it: the member who placed it, or a guest holding the order's access
 * token (and, for writes, its contact phone). Everything else is the same 404, so numbers can't be probed.
 */
export async function findOrderForAccess(
  db: Db,
  number: string,
  who: { user?: UserRow; token?: string; phone?: string | null; requirePhone?: boolean },
  secret: string,
  now: Date,
): Promise<OrderRow> {
  if (!/^SC-\d{4}-[0-9A-Z]{5}$/.test(number)) throw notFound();
  const [order] = await db.select().from(orders).where(eq(orders.number, number));
  if (!order) throw notFound();
  if (who.user && order.userId === who.user.id) return order;
  if (!who.token || !verifyOrderToken(who.token, number, secret, now)) throw notFound();
  if (who.requirePhone && who.phone !== order.contactPhoneE164) throw notFound();
  return order;
}
