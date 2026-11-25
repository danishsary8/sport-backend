import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Exec } from '../../db/exec.js';
import { notificationOutbox, orderItems, orders, type ProductSnapshot } from '../../db/schema/index.js';
import type { Notifier } from './notifier.js';
import { render, type OrderNotice, type Template } from './templates.js';

export const MAX_ATTEMPTS = 8;
const LEASE_MINUTES = 5;

/** Queues the messages an order event causes. Runs inside the caller's transaction; never sends. */
export async function enqueueOrderNotifications(tx: Exec, event: Template, orderId: string, extra: { reason?: string } = {}): Promise<void> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!order) return;
  const items = await tx.select({ snapshot: orderItems.productSnapshot, qty: orderItems.qty }).from(orderItems).where(eq(orderItems.orderId, orderId));
  const payload: OrderNotice = {
    number: order.number,
    status: order.status,
    totalCents: order.totalCents,
    totalKhr: order.totalKhr,
    contactName: order.contactName,
    contactPhone: order.contactPhoneE164,
    contactChannel: order.contactChannel,
    fulfillment: order.fulfillment,
    items: items.map((i) => {
      const s = i.snapshot as Partial<ProductSnapshot>;
      return { name: s.name?.en ?? 'Item', size: s.size ?? '', qty: i.qty };
    }),
    ...extra,
  };
  const rows: { channel: 'telegram' | 'email'; recipient: string }[] = [];
  if (event !== 'status_changed') rows.push({ channel: 'telegram', recipient: 'ops' });
  if ((event === 'payment_received' || event === 'status_changed') && order.contactEmail) rows.push({ channel: 'email', recipient: order.contactEmail });
  if (rows.length === 0) return;
  await tx.insert(notificationOutbox).values(rows.map((r) => ({ ...r, template: event, payload: payload as unknown as Record<string, unknown> })));
}

/** Sends due messages. Rows are leased first, so parallel workers never send one twice. */
export async function processOutbox(
  db: Db,
  notifiers: { telegram: Notifier; email: Notifier },
  now: Date,
  limit = 20,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const leased = await db.execute<{ id: number; channel: 'telegram' | 'email'; recipient: string; template: Template; payload: OrderNotice; attempts: number }>(sql`
    update notification_outbox set next_attempt_at = ${new Date(now.getTime() + LEASE_MINUTES * 60_000)}
    where id in (
      select id from notification_outbox where status = 'pending' and date_trunc('milliseconds', next_attempt_at) <= ${now}
      order by id limit ${limit} for update skip locked
    )
    returning id, channel, recipient, template, payload, attempts`);
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const row of leased.rows) {
    const notifier = notifiers[row.channel];
    if (!notifier.configured) {
      await db.update(notificationOutbox).set({ status: 'skipped', lastError: 'not configured' }).where(eq(notificationOutbox.id, row.id));
      result.skipped += 1;
      continue;
    }
    try {
      const message = render(row.template, row.payload, row.channel);
      await notifier.send({ channel: row.channel, to: row.recipient, ...message });
      await db.update(notificationOutbox).set({ status: 'sent', sentAt: now, attempts: row.attempts + 1 }).where(eq(notificationOutbox.id, row.id));
      result.sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      await db
        .update(notificationOutbox)
        .set({
          attempts,
          lastError: message,
          status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          nextAttemptAt: new Date(now.getTime() + Math.min(2 ** attempts, 60) * 60_000),
        })
        .where(eq(notificationOutbox.id, row.id));
      result.failed += 1;
    }
  }
  return result;
}
