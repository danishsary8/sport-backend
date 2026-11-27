import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { FakeNotifier } from '../../src/modules/notifications/notifier.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { staffToken } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let telegram: FakeNotifier;
let admin: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
let seq = 0;
async function order(status: string, paid: boolean, extra: { needsRefund?: boolean; daysAgo?: number; total?: number } = {}) {
  seq += 1;
  const total = extra.total ?? 5250;
  return (
    await q(
      `insert into orders (number, contact_name, contact_phone_e164, contact_channel, fulfillment, status, payment_status, payment_method,
         merchandise_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, pricing, needs_refund, paid_at, created_at)
       values ($1, 'A', '+85512345678', 'phone', 'delivery', $2, $3, 'aba_khqr', $4, 0, 0, $4, 4100, 0, '{}', $5, $6, now() - ($7 || ' days')::interval) returning id`,
      [`SC-2611-OV${String(seq).padStart(3, '0')}`, status, paid ? 'paid' : 'unpaid', total, extra.needsRefund ?? false, paid ? new Date() : null, String(extra.daysAgo ?? 0)],
    )
  ).rows[0].id;
}

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
});
afterAll(closeTestDb);
beforeEach(async () => {
  for (const t of ['orders', 'product_questions', 'notification_outbox', 'payment_webhook_events']) await q(`delete from ${t}`);
  await q('update stock set needs_count = false, on_hand = 10, reserved = 0, online_buffer = null');
  telegram = new FakeNotifier('telegram');
  ctx = memberApp(database, undefined, { notifiers: { telegram, email: new FakeNotifier('email', false) } });
  admin = await staffToken(ctx.app, database, ctx.fake, 'ov-admin', 'admin');
});

describe('GET /v1/admin/overview', () => {
  it('counts what needs attention', async () => {
    await order('confirmed', true);
    await order('pending_payment', false);
    await order('printing', true, { needsRefund: true, daysAgo: 3 });
    const productId = (await q('select id from products limit 1')).rows[0].id;
    await q("insert into product_questions (product_id, author_name, question) values ($1, 'A', 'Question here?')", [productId]);
    const [a, b] = (await q('select variant_id, branch_id from stock order by variant_id, branch_id limit 2')).rows;
    await q('update stock set on_hand = 3 where variant_id = $1 and branch_id = $2', [a.variant_id, a.branch_id]);
    await q('update stock set needs_count = true where variant_id = $1 and branch_id = $2', [b.variant_id, b.branch_id]);
    await q("insert into notification_outbox (channel, recipient, template, payload, status) values ('telegram', 'ops', 'order_placed', '{}', 'failed')");

    const res = await request(ctx.app).get('/v1/admin/overview').set(bearer(admin)).expect(200);
    expect(res.body).toMatchObject({
      today: { orders: 2, paidOrders: 2, revenueCents: 10500 },
      pendingPayments: 1,
      needsRefund: 1,
      awaitingFulfilment: { confirmed: 1, printing: 1, readyForPickup: 0, outForDelivery: 0 },
      openReturns: 0,
      pendingQuestions: 1,
      lowStockRows: 1,
      needsCountRows: 1,
      outboxFailed: 1,
    });
  });

  it('is for staff and admins only', async () => {
    const customer = await staffToken(ctx.app, database, ctx.fake, 'ov-customer', 'customer');
    await request(ctx.app).get('/v1/admin/overview').set(bearer(customer)).expect(403);
  });
});

describe('logs', () => {
  it('pages and filters payment webhooks', async () => {
    for (let i = 0; i < 3; i++) {
      await q(`insert into payment_webhook_events (provider, event_id, signature_valid, processing_status, payload) values ('payway', $1, true, $2, '{"tran_id":"x"}')`, [`e${i}`, i === 0 ? 'rejected' : 'processed']);
    }
    const res = await request(ctx.app).get('/v1/admin/payments/webhooks?status=processed&pageSize=1').set(bearer(admin)).expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({ provider: 'payway', processingStatus: 'processed', payload: { tran_id: 'x' } });
  });

  it('masks notification recipients and hides the message contents', async () => {
    await q("insert into notification_outbox (channel, recipient, template, payload) values ('email', 'dara@example.com', 'status_changed', '{\"contactName\":\"Dara\"}'), ('telegram', 'ops', 'order_placed', '{}')");
    const res = await request(ctx.app).get('/v1/admin/notifications').set(bearer(admin)).expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.notifications.map((n: { recipient: string }) => n.recipient).sort()).toEqual(['d***@example.com', 'ops']);
    expect(JSON.stringify(res.body)).not.toContain('Dara');
  });

  it('sends a test message on a configured channel', async () => {
    expect((await request(ctx.app).post('/v1/admin/notifications/test').set(bearer(admin)).send({ channel: 'telegram' }).expect(200)).body).toEqual({ sent: true });
    expect(telegram.sent).toHaveLength(1);
    expect((await request(ctx.app).post('/v1/admin/notifications/test').set(bearer(admin)).send({ channel: 'email' }).expect(200)).body).toEqual({ sent: false, error: 'not configured' });
    const staff = await staffToken(ctx.app, database, ctx.fake, 'ov-staff', 'staff');
    await request(ctx.app).post('/v1/admin/notifications/test').set(bearer(staff)).send({ channel: 'telegram' }).expect(403);
  });
});

describe('GET /v1/admin/overview/sales', () => {
  async function paid(daysAgo: number, total: number, status = 'confirmed', variant?: { id: string; qty: number }) {
    seq += 1;
    const id = (
      await q(
        `insert into orders (number, contact_name, contact_phone_e164, contact_channel, fulfillment, status, payment_status, payment_method,
           merchandise_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, pricing, paid_at, created_at)
         values ($1, 'A', '+85512345678', 'phone', 'delivery', $2, 'paid', 'aba_khqr', $3, 0, 0, $3, 4100, 0, '{}',
           now() - ($4 || ' days')::interval, now() - ($4 || ' days')::interval) returning id`,
        [`SC-2611-SL${String(seq).padStart(3, '0')}`, status, total, String(daysAgo)],
      )
    ).rows[0].id as string;
    if (variant)
      await q(
        `insert into order_items (order_id, variant_id, product_snapshot, unit_price_cents, line_total_cents, qty) values ($1, $2, '{}', $3::int, $3::int * $4::int, $4::int)`,
        [id, variant.id, total / variant.qty, variant.qty],
      );
    return id;
  }

  it('gives one bucket per day with paid orders and takings, zeros filled, cancelled left out', async () => {
    await paid(0, 10000);
    await paid(0, 5000);
    await paid(2, 3000);
    await paid(1, 99999, 'cancelled');
    const res = await request(ctx.app).get('/v1/admin/overview/sales').query({ days: 7 }).set(bearer(admin)).expect(200);
    expect(res.body.days).toHaveLength(7);
    const last = res.body.days.at(-1);
    expect(last).toMatchObject({ paidOrders: 2, revenueCents: 15000 });
    expect(res.body.days.at(-2)).toMatchObject({ paidOrders: 0, revenueCents: 0 });
    expect(res.body.days.at(-3)).toMatchObject({ paidOrders: 1, revenueCents: 3000 });
    expect(last.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.totals).toMatchObject({ paidOrders: 3, revenueCents: 18000, averageOrderCents: 6000 });
  });

  it('compares with the period before', async () => {
    await paid(1, 4000);
    await paid(9, 2000);
    const res = await request(ctx.app).get('/v1/admin/overview/sales').query({ days: 7 }).set(bearer(admin)).expect(200);
    expect(res.body.totals.revenueCents).toBe(4000);
    expect(res.body.previous.revenueCents).toBe(2000);
  });

  it('lists the best sellers and takings by category', async () => {
    const [v] = (await q("select v.id from variants v join products p on p.id = v.product_id join categories c on c.id = p.category_id where c.slug = 'boots' limit 1")).rows;
    await paid(0, 18000, 'confirmed', { id: v.id, qty: 2 });
    const res = await request(ctx.app).get('/v1/admin/overview/sales').set(bearer(admin)).expect(200);
    expect(res.body.days).toHaveLength(14);
    expect(res.body.topProducts[0]).toMatchObject({ qty: 2, revenueCents: 18000, name: expect.any(String) });
    expect(res.body.byCategory.find((c: { slug: string }) => c.slug === 'boots')).toMatchObject({ revenueCents: 18000 });
  });

  it('for staff, counts only the line items their store handled', async () => {
    const [b1, b2] = (await q('select id from branches order by id limit 2')).rows.map((r) => r.id as string);
    const [v1, v2] = (await q('select id from variants order by id limit 2')).rows.map((r) => r.id as string);
    const id = await paid(0, 10000, 'confirmed', { id: v1!, qty: 1 });
    await q(`insert into order_items (order_id, variant_id, product_snapshot, unit_price_cents, line_total_cents, qty) values ($1, $2, '{}', 7000, 7000, 1)`, [id, v2]);
    const items = (await q('select id, variant_id from order_items where order_id = $1', [id])).rows;
    for (const it of items) await q('insert into order_item_allocations (order_item_id, branch_id, qty) values ($1, $2, 1)', [it.id, it.variant_id === v1 ? b1 : b2]);
    const staff = await staffToken(ctx.app, database, ctx.fake, 'ov-staff-b1', 'staff', b1);
    const res = await request(ctx.app).get('/v1/admin/overview/sales').set(bearer(staff)).expect(200);
    expect(res.body.topProducts).toHaveLength(1);
    expect(res.body.topProducts[0]).toMatchObject({ revenueCents: 10000 });
    expect(res.body.byCategory.reduce((n: number, c: { revenueCents: number }) => n + c.revenueCents, 0)).toBe(10000);
  });

  it('cuts the period before at the same time of day, so a part-finished today compares fairly', async () => {
    // Paid 7 days ago plus one hour: later in that day than now, so it falls after the cut.
    await q(
      `insert into orders (number, contact_name, contact_phone_e164, contact_channel, fulfillment, status, payment_status, payment_method,
         merchandise_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, pricing, paid_at, created_at)
       values ('SC-2611-CUT01', 'A', '+85512345678', 'phone', 'delivery', 'confirmed', 'paid', 'aba_khqr', 500, 0, 0, 500, 4100, 0, '{}',
         now() - interval '7 days' + interval '1 hour', now() - interval '8 days')`,
    );
    await paid(8, 2000);
    const res = await request(ctx.app).get('/v1/admin/overview/sales').query({ days: 7 }).set(bearer(admin)).expect(200);
    expect(res.body.previous.revenueCents).toBe(2000);
  });

  it('refuses a range outside 7 to 90 days', async () => {
    await request(ctx.app).get('/v1/admin/overview/sales').query({ days: 3 }).set(bearer(admin)).expect(400);
  });
});
