import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, PAYMENTS_DEFAULT, payOrder, phnomPenhAddress, placeGuestOrder, setStockAt, staffToken, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
let admin: string;
let sensokStaff: string;
let anyStaff: string;
let customer: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const order = async (number: string) => (await q('select * from orders where number = $1', [number])).rows[0];
const onHand = async () => (await q('select sum(on_hand)::int as on_hand, sum(reserved)::int as reserved from stock where variant_id = $1', [jerseyM])).rows[0];
const setPayments = (value: object) => q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(value)]);

function act(token: string, number: string, action: string, body: object = {}) {
  return request(ctx.app).post(`/v1/admin/orders/${number}/${action}`).set(bearer(token)).send(body);
}

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
  await q('delete from carts');
  await q('delete from orders');
  await q('delete from notification_outbox');
  await q('delete from loyalty_ledger');
  await q('delete from loyalty_accounts');
  await q("delete from stock_movements where reason <> 'import'");
  await q("update promotions set used_count = 0 where code = 'CASTLE10'");
  await setStockAt(database, jerseyM, { sonthormuk: 10 });
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'ord-admin', 'admin');
  sensokStaff = await staffToken(ctx.app, database, ctx.fake, 'ord-sensok', 'staff', 'sensok');
  anyStaff = await staffToken(ctx.app, database, ctx.fake, 'ord-staff', 'staff');
  customer = await staffToken(ctx.app, database, ctx.fake, 'ord-customer', 'customer');
});

describe('who sees which orders', () => {
  it('keeps customers out and limits branch staff to their branch', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await request(ctx.app).get('/v1/admin/orders').set(bearer(customer)).expect(403);
    const all = await request(ctx.app).get('/v1/admin/orders').set(bearer(admin)).expect(200);
    expect(all.body.total).toBe(1);
    expect(all.body.orders[0]).toMatchObject({ number: body.order.number, branches: ['sonthormuk'], contactPhone: '+85512345678' });
    const scoped = await request(ctx.app).get('/v1/admin/orders').set(bearer(sensokStaff)).expect(200);
    expect(scoped.body.total).toBe(0);
    await request(ctx.app).get(`/v1/admin/orders/${body.order.number}`).set(bearer(sensokStaff)).expect(404);
    await act(sensokStaff, body.order.number, 'notes', { note: 'hello' }).expect(404);
    await request(ctx.app).get(`/v1/admin/orders/${body.order.number}`).set(bearer(anyStaff)).expect(200);
  });

  it('finds orders by the last phone digits or a number prefix', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const byPhone = await request(ctx.app).get('/v1/admin/orders?q=5678').set(bearer(admin)).expect(200);
    expect(byPhone.body.orders.map((o: { number: string }) => o.number)).toEqual([body.order.number]);
    const byNumber = await request(ctx.app).get(`/v1/admin/orders?q=${body.order.number.slice(0, 9).toLowerCase()}`).set(bearer(admin)).expect(200);
    expect(byNumber.body.total).toBe(1);
    const none = await request(ctx.app).get('/v1/admin/orders?q=0000').set(bearer(admin)).expect(200);
    expect(none.body.total).toBe(0);
  });
});

describe('order detail', () => {
  it('shows events, payments, allocations and a per-branch pick list', async () => {
    await setStockAt(database, jerseyM, { sonthormuk: 3, sensok: 3 });
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 3 });
    const res = await request(ctx.app).get(`/v1/admin/orders/${body.order.number}`).set(bearer(admin)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.payments[0]).toMatchObject({ attempt: 1, status: 'pending', tranId: body.payment!.tranId });
    expect(res.body.events[0]).toMatchObject({ to: 'pending_payment', kind: 'status' });
    expect(res.body.needsRefund).toBe(false);
    expect(Object.keys(res.body.pickList).sort()).toEqual(['sensok', 'sonthormuk']);
    expect(res.body.pickList.sonthormuk[0]).toMatchObject({ size: 'M', qty: 2 });
    expect(res.body.pickList.sensok[0]).toMatchObject({ qty: 1 });
    const scoped = await request(ctx.app).get(`/v1/admin/orders/${body.order.number}`).set(bearer(sensokStaff)).expect(200);
    expect(Object.keys(scoped.body.pickList)).toEqual(['sensok']);
  });
});

describe('status changes', () => {
  it('walks a paid delivery to completed, stamping delivery and telling the customer', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await payOrder(ctx.app, body.payment!.tranId);
    await q('delete from notification_outbox');
    await act(admin, body.order.number, 'status', { to: 'out_for_delivery' }).expect(200);
    const delivered = await act(anyStaff, body.order.number, 'status', { to: 'delivered', note: 'Left with guard' }).expect(200);
    expect(delivered.body.order.status).toBe('delivered');
    expect((await order(body.order.number)).delivered_at).toBeTruthy();
    expect((await q("select count(*)::int as n from notification_outbox where template = 'status_changed'")).rows[0].n).toBe(2);
    await act(admin, body.order.number, 'status', { to: 'completed' }).expect(200);
    const actors = await q("select actor from order_events where kind = 'status' and to_status = 'delivered'");
    expect(actors.rows[0].actor).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses moves the status machine or payment state do not allow', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const unpaid = await act(admin, body.order.number, 'status', { to: 'out_for_delivery' }).expect(409);
    expect(unpaid.body.error.code).toBe('invalid_transition');
    await payOrder(ctx.app, body.payment!.tranId);
    const skip = await act(admin, body.order.number, 'status', { to: 'delivered' }).expect(409);
    expect(skip.body.error.code).toBe('invalid_transition');
    await act(admin, body.order.number, 'status', { to: 'ready_for_pickup' }).expect(409);
  });

  it('lets exactly one of a cancel and a dispatch win when they race', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await payOrder(ctx.app, body.payment!.tranId);
    const [a, b] = await Promise.all([act(admin, body.order.number, 'cancel', { reason: 'Customer called' }), act(anyStaff, body.order.number, 'status', { to: 'out_for_delivery' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await q("select count(*)::int as n from stock_movements where reason = 'order_cancel'")).rows[0].n).toBe(a.status === 200 ? 1 : 0);
  });
});

describe('cancelling', () => {
  it('releases an unpaid order’s hold, promo use and payment attempt', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
    await agent.put('/v1/cart/promo').send({ code: 'CASTLE10' }).expect(200);
    const placed = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
    expect((await onHand()).reserved).toBe(1);
    const res = await act(admin, placed.body.order.number, 'cancel', { reason: 'Duplicate order' }).expect(200);
    expect(res.body.order.status).toBe('cancelled');
    expect((await onHand()).reserved).toBe(0);
    expect((await q("select used_count from promotions where code = 'CASTLE10'")).rows[0].used_count).toBe(0);
    expect(ctx.payments.cancelled).toContain(placed.body.payment.tranId);
    expect((await order(placed.body.order.number)).needs_refund).toBe(false);
  });

  it('puts a paid order’s units back, reverses points and flags the refund — once', async () => {
    const member = ctx.fake.token({ uid: 'cancel-member', phone: '+85512003333' });
    await request(ctx.app).post('/v1/cart/items').set(bearer(member)).send({ variantId: jerseyM, qty: 1 }).expect(200);
    const placed = await request(ctx.app).post('/v1/orders').set(bearer(member)).set(idem()).send(guestOrder(address)).expect(201);
    await payOrder(ctx.app, placed.body.payment.tranId);
    const before = (await q('select points_balance, lifetime_spend_cents from loyalty_accounts')).rows[0];
    expect(before.points_balance).toBeGreaterThan(0);
    expect((await onHand()).on_hand).toBe(9);

    await act(admin, placed.body.order.number, 'cancel', { reason: 'Out of stock in store' }).expect(200);
    expect((await onHand()).on_hand).toBe(10);
    expect((await q("select reason, delta_on_hand from stock_movements where reason = 'order_cancel'")).rows).toEqual([{ reason: 'order_cancel', delta_on_hand: 1 }]);
    const after = (await q('select points_balance, lifetime_spend_cents, tier from loyalty_accounts')).rows[0];
    expect(after).toEqual({ points_balance: 0, lifetime_spend_cents: 0, tier: 'bronze' });
    expect((await q("select delta from loyalty_ledger where reason = 'order_cancelled'")).rows[0].delta).toBe(-before.points_balance);
    expect((await order(placed.body.order.number)).needs_refund).toBe(true);

    await act(admin, placed.body.order.number, 'cancel', { reason: 'again' }).expect(409);
    expect((await onHand()).on_hand).toBe(10);
  });
});

describe('refunds, notes and cash at the counter', () => {
  it('marks a refund done and clears the flag', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await payOrder(ctx.app, body.payment!.tranId);
    await act(admin, body.order.number, 'cancel', { reason: 'Customer changed mind' }).expect(200);
    await act(admin, body.order.number, 'refunded', { note: 'Refunded in PayWay portal' }).expect(200);
    expect(await order(body.order.number)).toMatchObject({ payment_status: 'refunded', needs_refund: false });
  });

  it('clears a refund flag with a note', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await q('update orders set needs_refund = true');
    await act(admin, body.order.number, 'clear-refund-flag', { note: 'Customer took store credit' }).expect(200);
    expect((await order(body.order.number)).needs_refund).toBe(false);
  });

  it('keeps staff notes out of the customer timeline', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await act(anyStaff, body.order.number, 'notes', { note: 'Customer prefers evening delivery' }).expect(200);
    const staffView = await request(ctx.app).get(`/v1/admin/orders/${body.order.number}`).set(bearer(admin)).expect(200);
    expect(staffView.body.events.some((e: { note: string }) => e.note === 'Customer prefers evening delivery')).toBe(true);
    const customerView = await request(ctx.app).get(`/v1/orders/${body.order.number}`).set('x-order-token', body.orderAccessToken!).expect(200);
    expect(JSON.stringify(customerView.body)).not.toContain('evening delivery');
  });

  it('takes cash at the counter: stock leaves the shelf, points awarded, order completed', async () => {
    await setPayments({ ...PAYMENTS_DEFAULT, cash_on_pickup: true });
    try {
      const member = ctx.fake.token({ uid: 'cash-member', phone: '+85512004444' });
      await request(ctx.app).post('/v1/cart/items').set(bearer(member)).send({ variantId: jerseyM, qty: 1 }).expect(200);
      const placed = await request(ctx.app)
        .post('/v1/orders')
        .set(bearer(member))
        .set(idem())
        .send(guestOrder(address, { fulfillment: 'pickup', pickupBranchId: 'sonthormuk', address: undefined, shippingMethodId: undefined, paymentMethod: 'cash_on_pickup' }))
        .expect(201);
      const res = await act(anyStaff, placed.body.order.number, 'collect-cash').expect(200);
      expect(res.body.order).toMatchObject({ status: 'completed', paymentStatus: 'paid' });
      expect(await onHand()).toEqual({ on_hand: 9, reserved: 0 });
      expect((await q("select count(*)::int as n from loyalty_ledger where reason = 'order_paid'")).rows[0].n).toBe(1);
      expect((await order(placed.body.order.number)).delivered_at).toBeTruthy();
      await act(anyStaff, placed.body.order.number, 'collect-cash').expect(409);
    } finally {
      await setPayments(PAYMENTS_DEFAULT);
    }
  });
});
