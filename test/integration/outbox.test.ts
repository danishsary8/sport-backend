import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { FakeNotifier } from '../../src/modules/notifications/notifier.js';
import { enqueueOrderNotifications, processOutbox } from '../../src/modules/notifications/outbox.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let orderId: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const rows = async () => (await q('select channel, recipient, template, status, attempts, next_attempt_at, last_error from notification_outbox order by id')).rows;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from notification_outbox');
  await q('delete from orders');
  const r = await q(
    `insert into orders (number, contact_name, contact_phone_e164, contact_email, contact_channel, fulfillment, status, payment_method,
       merchandise_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, pricing)
     values ('SC-2611-OUTBX', 'Dara', '+85512345678', 'dara@example.com', 'telegram', 'delivery', 'confirmed', 'aba_khqr', 5000, 0, 250, 5250, 4100, 215300, '{}') returning id`,
  );
  orderId = r.rows[0].id;
  const variantId = (await q('select id from variants limit 1')).rows[0].id;
  await q(
    `insert into order_items (order_id, variant_id, product_snapshot, unit_price_cents, line_total_cents, qty) values ($1, $2, $3, 2500, 5000, 2)`,
    [orderId, variantId, JSON.stringify({ name: { en: 'Home Jersey' }, size: 'M' })],
  );
});

describe('notification outbox', () => {
  it('routes a payment to ops and to the customer email', async () => {
    await enqueueOrderNotifications(database.db, 'payment_received', orderId);
    expect((await rows()).map((r) => [r.channel, r.recipient, r.template])).toEqual([
      ['telegram', 'ops', 'payment_received'],
      ['email', 'dara@example.com', 'payment_received'],
    ]);
  });

  it('sends pending messages', async () => {
    await enqueueOrderNotifications(database.db, 'payment_received', orderId);
    const telegram = new FakeNotifier('telegram');
    const email = new FakeNotifier('email');
    expect(await processOutbox(database.db, { telegram, email }, new Date())).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(telegram.sent[0]!.text).toContain('SC-2611-OUTBX');
    expect(email.sent[0]!.to).toBe('dara@example.com');
    expect((await rows()).every((r) => r.status === 'sent')).toBe(true);
  });

  it('backs off after a failure and gives up after 8 attempts', async () => {
    await enqueueOrderNotifications(database.db, 'status_changed', orderId);
    const email = new FakeNotifier('email');
    email.failNext(1);
    const now = new Date();
    expect(await processOutbox(database.db, { telegram: new FakeNotifier('telegram'), email }, now)).toMatchObject({ failed: 1 });
    const [row] = await rows();
    expect(row.attempts).toBe(1);
    expect(row.status).toBe('pending');
    expect(Math.abs(new Date(row.next_attempt_at).getTime() - (now.getTime() + 2 * 60_000))).toBeLessThan(5_000);
    expect(row.last_error).toContain('fake send failure');

    await q("update notification_outbox set attempts = 7, next_attempt_at = now() - interval '1 minute'");
    email.failNext(1);
    await processOutbox(database.db, { telegram: new FakeNotifier('telegram'), email }, new Date());
    expect((await rows())[0].status).toBe('failed');
  });

  it('skips a channel that is not configured', async () => {
    await enqueueOrderNotifications(database.db, 'status_changed', orderId);
    const email = new FakeNotifier('email', false);
    expect(await processOutbox(database.db, { telegram: new FakeNotifier('telegram'), email }, new Date())).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect((await rows())[0].status).toBe('skipped');
  });

  it('sends each message once when two workers run together', async () => {
    await enqueueOrderNotifications(database.db, 'payment_received', orderId);
    const telegram = new FakeNotifier('telegram');
    const email = new FakeNotifier('email');
    await Promise.all([processOutbox(database.db, { telegram, email }, new Date()), processOutbox(database.db, { telegram, email }, new Date())]);
    expect(telegram.sent.length + email.sent.length).toBe(2);
  });
});
