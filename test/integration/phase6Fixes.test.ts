import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { FakeNotifier } from '../../src/modules/notifications/notifier.js';
import { bearer, memberApp } from '../helpers/app.js';
import { guestOrder, idem, JERSEY, PAYMENTS_DEFAULT, payOrder, phnomPenhAddress, placeGuestOrder, setStockAt, staffToken, variantId } from '../helpers/checkout.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
let admin: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const MIN = 60_000;
const sweep = (offsetMs: number) =>
  sweepOnce({
    database,
    payments: ctx.payments,
    notifiers: { telegram: new FakeNotifier('telegram'), email: new FakeNotifier('email') },
    logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    now: () => new Date(Date.now() + offsetMs),
  });
const stock = async () => (await q("select on_hand, reserved from stock where variant_id = $1 and branch_id = 'sonthormuk'", [jerseyM])).rows[0];
const setPayments = (value: object) => q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(value)]);
const act = (number: string, action: string, body: object = {}) => request(ctx.app).post(`/v1/admin/orders/${number}/${action}`).set(bearer(admin)).send(body);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  jerseyM = await variantId(database, JERSEY, 'M');
});
afterAll(async () => {
  await setPayments(PAYMENTS_DEFAULT);
  await closeTestDb();
});
beforeEach(async () => {
  for (const t of ['carts', 'rma_requests', 'orders', 'notification_outbox', 'payment_webhook_events', 'promotion_redemptions', 'loyalty_ledger', 'loyalty_accounts']) await q(`delete from ${t}`);
  await q("update promotions set used_count = 0, max_uses_per_user = null where code = 'CASTLE10'");
  await setStockAt(database, jerseyM, { sonthormuk: 10 });
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'fix6-admin', 'admin');
});

describe('a payment that arrives after the sweeper expired the order', () => {
  it('is still accepted: the order is revived when stock allows', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    expect((await sweep(31 * MIN)).expired).toBe(1);
    expect((await q('select status from payments')).rows[0].status).toBe('expired');
    await q('update payments set last_checked_at = null'); // real time passes; the test clock jumped ahead
    ctx.payments.approve(body.payment!.tranId);
    const raw = JSON.stringify({ tran_id: body.payment!.tranId, status: 'approved' });
    await request(ctx.app).post('/v1/webhooks/payway').set('content-type', 'application/json').set('x-fake-signature', ctx.payments.sign(raw)).send(raw).expect(200);
    expect((await q('select status, payment_status from orders')).rows[0]).toEqual({ status: 'confirmed', payment_status: 'paid' });
  });
});

describe('the sweeper as a safety net', () => {
  it('picks up a late payment on an order it expired, even without a webhook', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await sweep(31 * MIN);
    await q('update payments set last_checked_at = null');
    ctx.payments.approve(body.payment!.tranId);
    await sweep(32 * MIN);
    expect((await q('select status, payment_status from orders')).rows[0]).toEqual({ status: 'confirmed', payment_status: 'paid' });
  });
});

describe('staff cannot push orders past payment', () => {
  it('refuses confirming, printing or expiring an unpaid order', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    for (const to of ['confirmed', 'printing', 'expired']) {
      const res = await act(body.order.number, 'status', { to }).expect(409);
      expect(res.body.error.code).toBe('invalid_transition');
    }
  });

  it('refuses reviving an expired order by hand', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await sweep(31 * MIN);
    await act(body.order.number, 'status', { to: 'confirmed' }).expect(409);
    expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
  });
});

describe('unpaid pickup orders marked ready', () => {
  it('still expire when the hold ends', async () => {
    await setPayments({ ...PAYMENTS_DEFAULT, cash_on_pickup: true });
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 }, { fulfillment: 'pickup', pickupBranchId: 'sonthormuk', address: undefined, shippingMethodId: undefined, paymentMethod: 'cash_on_pickup' });
    await setPayments(PAYMENTS_DEFAULT);
    await act(body.order.number, 'status', { to: 'ready_for_pickup' }).expect(200);
    expect((await sweep(49 * 60 * MIN)).expired).toBe(1);
    expect((await q('select status from orders')).rows[0].status).toBe('expired');
    expect(await stock()).toEqual({ on_hand: 10, reserved: 0 });
  });
});

describe('cancelling a paid order', () => {
  it('alerts ops about the refund and gives the promo use back', async () => {
    await q("update promotions set max_uses_per_user = 1 where code = 'CASTLE10'");
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
    await agent.put('/v1/cart/promo').send({ code: 'CASTLE10' }).expect(200);
    const placed = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
    await payOrder(ctx.app, placed.body.payment.tranId);
    expect((await q('select count(*)::int as n from promotion_redemptions')).rows[0].n).toBe(1);
    await act(placed.body.order.number, 'cancel', { reason: 'Damaged in store' }).expect(200);
    expect((await q("select recipient from notification_outbox where template = 'needs_refund'")).rows).toEqual([{ recipient: 'ops' }]);
    expect((await q('select count(*)::int as n from promotion_redemptions')).rows[0].n).toBe(0);
    expect((await q("select used_count from promotions where code = 'CASTLE10'")).rows[0].used_count).toBe(0);
    // The same phone can use the one-per-customer code again.
    const again = request.agent(ctx.app);
    await again.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
    await again.put('/v1/cart/promo').send({ code: 'CASTLE10' }).expect(200);
    await again.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
  });
});

describe('partial refunds', () => {
  it('never add up to more than the line cost', async () => {
    const member = ctx.fake.token({ uid: 'fix6-member', phone: '+85512009100' });
    await q("update variants set price_cents = 3333 where id = $1", [jerseyM]);
    try {
      await request(ctx.app).post('/v1/cart/items').set(bearer(member)).send({ variantId: jerseyM, qty: 2 }).expect(200);
      await request(ctx.app).put('/v1/cart/promo').set(bearer(member)).send({ code: 'CASTLE10' }).expect(200);
      const placed = await request(ctx.app).post('/v1/orders').set(bearer(member)).set(idem()).send(guestOrder(address)).expect(201);
      await payOrder(ctx.app, placed.body.payment.tranId);
      await q("update orders set status = 'delivered', delivered_at = now() - interval '1 day'");
      const item = (await q('select id, line_total_cents from order_items')).rows[0];
      const one = { orderNumber: placed.body.order.number, resolution: 'refund', items: [{ orderItemId: item.id, qty: 1, reason: 'x' }] };
      const a = await request(ctx.app).post('/v1/me/returns').set(bearer(member)).send(one).expect(201);
      const b = await request(ctx.app).post('/v1/me/returns').set(bearer(member)).send(one).expect(201);
      expect(a.body.return.refundCents + b.body.return.refundCents).toBe(item.line_total_cents);
    } finally {
      await q("update variants set price_cents = 3500 where id = $1", [jerseyM]);
    }
  });
});
