import { eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Exec } from '../../db/exec.js';
import { notificationOutbox, orderItems, orders, type ProductSnapshot } from '../../db/schema/index.js';
import type { Notifier } from './notifier.js';
import { render, type OrderNotice, type Template } from './templates.js';

export const MAX_ATTEMPTS = 8;
const LEASE_MINUTES = 5;

/** Queues the messages an order event causes. Runs inside the caller's transaction; never sends. */
export async function enqueueOrderNotifications(tx: Exec, event: Template, orderId: string, extra: { reason?: string; paidCents?: number } = {}): Promise<void> {
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

/** Queues an arbitrary message (already-built payload) for one recipient. */
export async function enqueueMessage(tx: Exec, channel: 'telegram' | 'email', recipient: string, template: Template, payload: OrderNotice): Promise<void> {
  await tx.insert(notificationOutbox).values({ channel, recipient, template, payload: payload as unknown as Record<string, unknown> });
}

/** Return requests go to ops; decisions go to the member (account email, else the order's contact email). */
export async function enqueueRmaNotification(tx: Exec, template: 'rma_requested' | 'rma_decided', rmaId: string): Promise<void> {
  const r = await tx.execute<{
    number: string; resolution: string; status: string; refund_cents: number; decision_note: string | null; item_count: number;
    order_number: string; status_o: string; total_cents: number; total_khr: number; contact_name: string; contact_phone_e164: string;
    contact_channel: string; fulfillment: string; contact_email: string | null; user_email: string | null;
  }>(sql`
    select r.number, r.resolution, r.status, r.refund_cents, r.decision_note,
      (select coalesce(sum(qty), 0)::int from rma_items i where i.rma_id = r.id) as item_count,
      o.number as order_number, o.status as status_o, o.total_cents, o.total_khr, o.contact_name, o.contact_phone_e164, o.contact_channel,
      o.fulfillment, o.contact_email, u.email as user_email
    from rma_requests r join orders o on o.id = r.order_id left join users u on u.id = r.user_id where r.id = ${rmaId}`);
  const row = r.rows[0];
  if (!row) return;
  const payload: OrderNotice = {
    number: row.order_number, status: row.status_o, totalCents: row.total_cents, totalKhr: row.total_khr, contactName: row.contact_name,
    contactPhone: row.contact_phone_e164, contactChannel: row.contact_channel, fulfillment: row.fulfillment, items: [],
    rma: { number: row.number, resolution: row.resolution, status: row.status, refundCents: row.refund_cents, decisionNote: row.decision_note, itemCount: row.item_count },
  };
  if (template === 'rma_requested') await enqueueMessage(tx, 'telegram', 'ops', template, payload);
  else {
    const to = row.user_email ?? row.contact_email;
    if (to) await enqueueMessage(tx, 'email', to, template, payload);
  }
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
