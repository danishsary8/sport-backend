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
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const act = (number: string, action: string, body: object = {}) => request(ctx.app).post(`/v1/admin/orders/${number}/${action}`).set(bearer(admin)).send(body);
const setPayments = (value: object) => q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(value)]);

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
  for (const t of ['carts', 'rma_requests', 'orders', 'notification_outbox', 'product_questions']) await q(`delete from ${t}`);
  await setStockAt(database, jerseyM, { sonthormuk: 10 });
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'minor-admin', 'admin');
});

describe('refund bookkeeping', () => {
  it('cancelling an order already refunded does not ask for a second refund', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await payOrder(ctx.app, body.payment!.tranId);
    await q("update orders set payment_status = 'refunded'");
    await act(body.order.number, 'cancel', { reason: 'Refunded at the counter already' }).expect(200);
    expect((await q('select needs_refund from orders')).rows[0].needs_refund).toBe(false);
    expect((await q("select count(*)::int as n from notification_outbox where template = 'needs_refund'")).rows[0].n).toBe(0);
  });

  it('a refund for a returned item leaves the rest of the order paid', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 2 });
    await payOrder(ctx.app, body.payment!.tranId);
    await q("update orders set status = 'delivered', delivered_at = now(), needs_refund = true");
    await act(body.order.number, 'refunded', { note: 'Refunded one returned shirt' }).expect(200);
    expect((await q('select payment_status, needs_refund from orders')).rows[0]).toEqual({ payment_status: 'paid', needs_refund: false });
  });

  it('a refund for a cancelled order marks the whole order refunded', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await payOrder(ctx.app, body.payment!.tranId);
    await act(body.order.number, 'cancel', { reason: 'x' }).expect(200);
    await act(body.order.number, 'refunded').expect(200);
    expect((await q('select payment_status from orders')).rows[0].payment_status).toBe('refunded');
  });
});

describe('cash at the counter', () => {
  it('sends one "completed" message and closes any open QR', async () => {
    await setPayments({ ...PAYMENTS_DEFAULT, cash_on_pickup: true });
    try {
      const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 }, { fulfillment: 'pickup', pickupBranchId: 'sonthormuk', address: undefined, shippingMethodId: undefined });
      await q('delete from notification_outbox');
      await act(body.order.number, 'collect-cash').expect(200);
      expect((await q("select count(*)::int as n from notification_outbox where template = 'status_changed'")).rows[0].n).toBe(1);
      expect((await q('select status from payments')).rows[0].status).toBe('cancelled');
      expect(ctx.payments.cancelled).toContain(body.payment!.tranId);
    } finally {
      await setPayments(PAYMENTS_DEFAULT);
    }
  });
});

describe('numbers that ignore cancelled orders', () => {
  it('leaves cancelled orders out of revenue and insights', async () => {
    const member = ctx.fake.token({ uid: 'minor-member', phone: '+85512009500' });
    await request(ctx.app).post('/v1/cart/items').set(bearer(member)).send({ variantId: jerseyM, qty: 1 }).expect(200);
    const placed = await request(ctx.app).post('/v1/orders').set(bearer(member)).set(idem()).send(guestOrder(address)).expect(201);
    await payOrder(ctx.app, placed.body.payment.tranId);
    await act(placed.body.order.number, 'cancel', { reason: 'x' }).expect(200);
    const overview = await request(ctx.app).get('/v1/admin/overview').set(bearer(admin)).expect(200);
    expect(overview.body.today.revenueCents).toBe(0);
    const insights = await request(ctx.app).get('/v1/me/insights').set(bearer(member)).expect(200);
    expect(insights.body.totalOrders).toBe(0);
  });
});

describe('question moderation', () => {
  it('records who hid a question', async () => {
    await request(ctx.app).post(`/v1/catalog/products/${JERSEY}/questions`).send({ authorName: 'A', question: 'Is this the fan version?' }).expect(201);
    const id = (await q('select id from product_questions')).rows[0].id;
    await request(ctx.app).patch(`/v1/admin/questions/${id}`).set(bearer(admin)).send({ status: 'hidden' }).expect(200);
    const row = (await q('select moderated_by, moderated_at from product_questions')).rows[0];
    expect(row.moderated_by).toBeTruthy();
    expect(row.moderated_at).toBeTruthy();
  });
});
