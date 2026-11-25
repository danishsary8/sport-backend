import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { applyProviderResult } from '../../src/modules/payments/confirm.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { idem, guestOrder, JERSEY, phnomPenhAddress, placeGuestOrder, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const orderRow = async (number: string) => (await q('select * from orders where number = $1', [number])).rows[0];
const deps = () => ({ db: database.db, now: () => new Date() });

function webhook(tranId: string, status = 'approved') {
  const body = JSON.stringify({ tran_id: tranId, status });
  return request(ctx.app).post('/v1/webhooks/payway').set('content-type', 'application/json').set('x-fake-signature', ctx.payments.sign(body)).send(body);
}

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  jerseyM = await variantId(database, JERSEY, 'M');
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await q('delete from payment_webhook_events');
  await q('delete from notification_outbox');
  await q('delete from loyalty_ledger');
  await q('delete from loyalty_accounts');
  await q("delete from stock_movements where reason <> 'import'");
  await setProductStock(database, JERSEY, 10);
  ctx = memberApp(database);
});

describe('payment approved', () => {
  it('confirms the order, takes the stock off the shelf and notifies', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 2 });
    ctx.payments.approve(body.payment!.tranId);
    await webhook(body.payment!.tranId).expect(200);

    const order = await orderRow(body.order.number);
    expect(order).toMatchObject({ status: 'confirmed', payment_status: 'paid', needs_refund: false });
    expect(order.paid_at).toBeTruthy();
    expect((await q('select sum(on_hand)::int as on_hand, sum(reserved)::int as reserved from stock where variant_id = $1', [jerseyM])).rows[0]).toEqual({ on_hand: 28, reserved: 0 });
    const commits = await q("select count(*)::int as n from stock_movements where reason = 'order_commit'");
    const allocs = await q('select count(*)::int as n from order_item_allocations');
    expect(commits.rows[0].n).toBe(allocs.rows[0].n);
    expect((await q("select template from notification_outbox where template = 'payment_received'")).rows.length).toBe(2);
  });

  it('sends printed shirts to printing', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1, customPrint: { name: 'DARA', number: 10, patch: 'none' } });
    ctx.payments.approve(body.payment!.tranId);
    await webhook(body.payment!.tranId).expect(200);
    expect((await orderRow(body.order.number)).status).toBe('printing');
  });

  it('awards points and spend to a member with a verified phone', async () => {
    const token = ctx.fake.token({ uid: 'loyal', phone: '+85512000555' });
    await request(ctx.app).post('/v1/auth/session').set(bearer(token)).expect(200);
    await q("insert into loyalty_accounts (user_id, lifetime_spend_cents) select id, 10000 from users where firebase_uid = 'loyal'");
    await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: jerseyM, qty: 1 }).expect(200);
    const placed = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(address)).expect(201);
    const { totalCents, shippingCents } = placed.body.order.pricing;
    ctx.payments.approve(placed.body.payment.tranId);
    await webhook(placed.body.payment.tranId).expect(200);

    const merch = totalCents - shippingCents;
    const account = (await q("select points_balance, lifetime_spend_cents, tier from loyalty_accounts")).rows[0];
    expect(account.points_balance).toBe(Math.floor((merch * 10) / 100));
    expect(account.lifetime_spend_cents).toBe(10000 + merch);
    expect(account.tier).toBe(10000 + merch >= 15000 ? 'silver' : 'bronze');
    expect((await q("select delta, reason from loyalty_ledger")).rows).toEqual([{ delta: Math.floor((merch * 10) / 100), reason: 'order_paid' }]);
  });

  it('gives no points to a member without a verified phone', async () => {
    const token = ctx.fake.token({ uid: 'google-only', email: 'g@example.com' });
    await request(ctx.app).post('/v1/auth/session').set(bearer(token)).expect(200);
    await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: jerseyM, qty: 1 }).expect(200);
    const placed = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(address)).expect(201);
    ctx.payments.approve(placed.body.payment.tranId);
    await webhook(placed.body.payment.tranId).expect(200);
    expect((await q('select count(*)::int as n from loyalty_ledger')).rows[0].n).toBe(0);
  });

  it('commits once when the same webhook arrives three times', async () => {
    await q("update promotions set used_count = 0 where code = 'CASTLE10'");
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
    await agent.put('/v1/cart/promo').send({ code: 'CASTLE10' }).expect(200);
    const placed = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
    const tranId = placed.body.payment.tranId;
    ctx.payments.approve(tranId);
    for (let i = 0; i < 3; i++) await webhook(tranId).expect(200);
    expect((await q("select count(*)::int as n from stock_movements where reason = 'order_commit'")).rows[0].n).toBe(1);
    expect((await q('select count(*)::int as n from promotion_redemptions')).rows[0].n).toBe(1);
    expect((await q('select count(*)::int as n from payment_webhook_events')).rows[0].n).toBe(1);
    expect((await q("select count(*)::int as n from order_events where kind = 'status' and to_status = 'confirmed'")).rows[0].n).toBe(1);
  });

  it('commits once when the poll and the webhook race', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    ctx.payments.approve(body.payment!.tranId);
    await Promise.all([
      webhook(body.payment!.tranId),
      request(ctx.app).get(`/v1/orders/${body.order.number}/payment-status`).set('x-order-token', body.orderAccessToken!),
      applyProviderResult(deps(), body.payment!.tranId, { status: 'approved', amountCents: body.order.pricing.totalCents, raw: null }, 'sweeper'),
    ]);
    expect((await q("select count(*)::int as n from stock_movements where reason = 'order_commit'")).rows[0].n).toBe(1);
    expect((await orderRow(body.order.number)).status).toBe('confirmed');
  });
});

describe('untrusted webhooks', () => {
  it('rejects a webhook the provider does not confirm', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await webhook(body.payment!.tranId, 'approved').expect(200);
    expect((await orderRow(body.order.number)).status).toBe('pending_payment');
    expect((await q('select processing_status, error from payment_webhook_events')).rows[0]).toEqual({ processing_status: 'rejected', error: 'status_mismatch' });
  });

  it('refuses a bad signature and records it', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    ctx.payments.approve(body.payment!.tranId);
    const res = await request(ctx.app).post('/v1/webhooks/payway').set('x-fake-signature', 'forged').send({ tran_id: body.payment!.tranId, status: 'approved' }).expect(401);
    expect(res.body.error.code).toBe('invalid_signature');
    expect((await q('select signature_valid, processing_status from payment_webhook_events')).rows[0]).toEqual({ signature_valid: false, processing_status: 'rejected' });
    expect((await orderRow(body.order.number)).status).toBe('pending_payment');
  });

  it('ignores an unknown transaction', async () => {
    await webhook('SC2611ZZZZZ-1').expect(200);
    expect((await q('select processing_status from payment_webhook_events')).rows[0].processing_status).toBe('ignored');
  });
});

describe('paid late or twice', () => {
  it('re-reserves and confirms when an expired order is paid and stock is still there', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await q("update orders set status = 'expired' where number = $1", [body.order.number]);
    await q('update stock set reserved = 0 where variant_id = $1', [jerseyM]);
    ctx.payments.approve(body.payment!.tranId);
    await webhook(body.payment!.tranId).expect(200);
    const order = await orderRow(body.order.number);
    expect(order).toMatchObject({ status: 'confirmed', payment_status: 'paid', needs_refund: false });
    expect((await q('select sum(on_hand)::int as n from stock where variant_id = $1', [jerseyM])).rows[0].n).toBe(29);
  });

  it('flags a refund when an expired order is paid and stock is gone', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await q("update orders set status = 'expired' where number = $1", [body.order.number]);
    await setStockAt(database, jerseyM, {});
    ctx.payments.approve(body.payment!.tranId);
    await webhook(body.payment!.tranId).expect(200);
    const order = await orderRow(body.order.number);
    expect(order).toMatchObject({ status: 'expired', payment_status: 'paid', needs_refund: true });
    expect((await q("select id from notification_outbox where template = 'needs_refund'")).rows.length).toBe(1);
  });

  it('flags a refund when a second attempt is also paid', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const first = body.payment!.tranId;
    const retry = await request(ctx.app)
      .post(`/v1/orders/${body.order.number}/payments`)
      .send({ method: 'card', contactPhone: '012 345 678', orderAccessToken: body.orderAccessToken })
      .expect(201);
    ctx.payments.approve(retry.body.payment.tranId);
    await webhook(retry.body.payment.tranId).expect(200);
    ctx.payments.approve(first);
    await webhook(first).expect(200);
    expect(await orderRow(body.order.number)).toMatchObject({ status: 'confirmed', needs_refund: true });
    expect((await q("select count(*)::int as n from stock_movements where reason = 'order_commit'")).rows[0].n).toBe(1);
  });

  it('flags a refund and does not fulfil when the paid amount is wrong', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    ctx.payments.approve(body.payment!.tranId, 1);
    await webhook(body.payment!.tranId).expect(200);
    expect(await orderRow(body.order.number)).toMatchObject({ status: 'pending_payment', payment_status: 'unpaid', needs_refund: true });
    expect((await q("select count(*)::int as n from stock_movements where reason = 'order_commit'")).rows[0].n).toBe(0);
  });
});
