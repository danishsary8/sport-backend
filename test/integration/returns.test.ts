import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, payOrder, phnomPenhAddress, setStockAt, staffToken, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

const SOCKS = 'trusox-3-0-mid-calf-non-slip-grip-socks';
let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
const v = {} as Record<'jerseyM' | 'jerseyL' | 'socks', string>;
let member: string;
let admin: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const stockAt = async (variant: string, branch = 'sonthormuk') =>
  (await q('select on_hand, reserved from stock where variant_id = $1 and branch_id = $2', [variant, branch])).rows[0];

/** A paid member order, marked delivered `daysAgo` days ago. Returns the order number and its items. */
async function deliveredOrder(lines: { variantId: string; qty: number; customPrint?: object }[], daysAgo = 3, promo?: string) {
  for (const line of lines) await request(ctx.app).post('/v1/cart/items').set(bearer(member)).send(line).expect(200);
  if (promo) await request(ctx.app).put('/v1/cart/promo').set(bearer(member)).send({ code: promo }).expect(200);
  const placed = await request(ctx.app).post('/v1/orders').set(bearer(member)).set(idem()).send(guestOrder(address)).expect(201);
  await payOrder(ctx.app, placed.body.payment.tranId);
  await q(`update orders set status = 'delivered', delivered_at = now() - ($2 || ' days')::interval where number = $1`, [placed.body.order.number, String(daysAgo)]);
  const items = (await q('select id, variant_id, qty, line_total_cents from order_items where order_id = (select id from orders where number = $1)', [placed.body.order.number])).rows;
  return { number: placed.body.order.number as string, items };
}

function ask(body: object, token = member) {
  return request(ctx.app).post('/v1/me/returns').set(bearer(token)).send(body);
}

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  v.jerseyM = await variantId(database, JERSEY, 'M');
  v.jerseyL = await variantId(database, JERSEY, 'L');
  v.socks = await variantId(database, SOCKS);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from rma_requests');
  await q('delete from orders');
  await q('delete from notification_outbox');
  await q('delete from loyalty_ledger');
  await q('delete from loyalty_accounts');
  await q("delete from stock_movements where reason <> 'import'");
  await q("update variants set price_cents = 3500 where product_id = (select id from products where slug = $1)", [JERSEY]);
  await setStockAt(database, v.jerseyM, { sonthormuk: 10 });
  await setStockAt(database, v.jerseyL, { sonthormuk: 10 });
  await setProductStock(database, SOCKS, 10);
  ctx = memberApp(database);
  member = ctx.fake.token({ uid: 'rma-member', phone: '+85512005555', email: 'rma@example.com' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(member)).expect(200);
  await q("update users set email = 'rma@example.com' where firebase_uid = 'rma-member'");
  admin = await staffToken(ctx.app, database, ctx.fake, 'rma-admin', 'admin');
});

describe('refunds', () => {
  it('refunds exactly the paid share of a discounted line, and only flags the refund when approved', async () => {
    const order = await deliveredOrder([{ variantId: v.jerseyM, qty: 3 }], 3, 'CASTLE10');
    const item = order.items[0];
    const res = await ask({ orderNumber: order.number, resolution: 'refund', items: [{ orderItemId: item.id, qty: 1, reason: 'Too small' }] }).expect(201);
    expect(res.body.return).toMatchObject({ resolution: 'refund', status: 'requested', refundCents: Math.round(item.line_total_cents / 3) });
    expect(res.body.return.number).toMatch(/^RMA-\d{4}-/);
    expect((await q('select needs_refund from orders')).rows[0].needs_refund).toBe(false);
    expect((await q("select template, recipient from notification_outbox where template = 'rma_requested'")).rows).toEqual([{ template: 'rma_requested', recipient: 'ops' }]);

    const pointsBefore = (await q('select points_balance from loyalty_accounts')).rows[0].points_balance;
    const decided = await request(ctx.app).post(`/v1/admin/returns/${res.body.return.number}/decision`).set(bearer(admin)).send({ decision: 'approve' }).expect(200);
    expect(decided.body.return.status).toBe('approved');
    expect((await q('select needs_refund from orders')).rows[0].needs_refund).toBe(true);
    expect((await stockAt(v.jerseyM)).on_hand).toBe(8);
    const reversal = (await q("select delta from loyalty_ledger where reason = 'rma_reversal'")).rows[0].delta;
    expect(reversal).toBe(-Math.floor((Math.round(item.line_total_cents / 3) * 10) / 100));
    expect((await q('select points_balance from loyalty_accounts')).rows[0].points_balance).toBe(pointsBefore + reversal);
    expect((await q("select recipient from notification_outbox where template = 'rma_decided'")).rows).toEqual([{ recipient: 'rma@example.com' }]);
    await request(ctx.app).post(`/v1/admin/returns/${res.body.return.number}/decision`).set(bearer(admin)).send({ decision: 'approve' }).expect(409);
  });

  it('closes refunds after 14 days but allows day 13', async () => {
    const late = await deliveredOrder([{ variantId: v.jerseyM, qty: 1 }], 15);
    const res = await ask({ orderNumber: late.number, resolution: 'refund', items: [{ orderItemId: late.items[0].id, qty: 1, reason: 'x' }] }).expect(400);
    expect(res.body.error).toMatchObject({ code: 'return_not_allowed', details: [{ orderItemId: late.items[0].id, reason: 'window_closed' }] });
    const ok = await deliveredOrder([{ variantId: v.jerseyM, qty: 1 }], 13);
    await ask({ orderNumber: ok.number, resolution: 'refund', items: [{ orderItemId: ok.items[0].id, qty: 1, reason: 'x' }] }).expect(201);
  });
});

describe('size exchanges', () => {
  it('holds the new size at once; reject releases it, approve swaps the stock', async () => {
    const order = await deliveredOrder([{ variantId: v.jerseyM, qty: 1 }]);
    const body = { orderNumber: order.number, resolution: 'size_exchange', items: [{ orderItemId: order.items[0].id, qty: 1, reason: 'Too small', exchangeVariantId: v.jerseyL }] };
    const first = await ask(body).expect(201);
    expect(await stockAt(v.jerseyL)).toEqual({ on_hand: 10, reserved: 1 });
    await request(ctx.app).post(`/v1/admin/returns/${first.body.return.number}/decision`).set(bearer(admin)).send({ decision: 'reject', note: 'Worn' }).expect(200);
    expect(await stockAt(v.jerseyL)).toEqual({ on_hand: 10, reserved: 0 });

    const second = await ask(body).expect(201);
    await request(ctx.app).post(`/v1/admin/returns/${second.body.return.number}/decision`).set(bearer(admin)).send({ decision: 'approve', branchId: 'sensok' }).expect(200);
    expect(await stockAt(v.jerseyL)).toEqual({ on_hand: 9, reserved: 0 });
    expect((await stockAt(v.jerseyM, 'sensok')).on_hand).toBe(1);
    expect((await q("select reason from stock_movements where reason in ('exchange_reserve','exchange_release','exchange_commit','rma_restock') order by id")).rows.map((r) => r.reason)).toEqual([
      'exchange_reserve',
      'exchange_release',
      'exchange_reserve',
      'rma_restock',
      'exchange_commit',
    ]);
    expect((await q('select needs_refund from orders')).rows[0].needs_refund).toBe(false);
  });

  it('only swaps for the same product at the same price, within 30 days', async () => {
    const order = await deliveredOrder([{ variantId: v.jerseyM, qty: 1 }]);
    const item = order.items[0].id;
    const other = await ask({ orderNumber: order.number, resolution: 'size_exchange', items: [{ orderItemId: item, qty: 1, reason: 'x', exchangeVariantId: v.socks }] }).expect(400);
    expect(other.body.error.details[0].reason).toBe('exchange_variant_invalid');
    await q('update variants set price_cents = 4000 where id = $1', [v.jerseyL]);
    const pricier = await ask({ orderNumber: order.number, resolution: 'size_exchange', items: [{ orderItemId: item, qty: 1, reason: 'x', exchangeVariantId: v.jerseyL }] }).expect(400);
    expect(pricier.body.error.details[0].reason).toBe('exchange_variant_invalid');
    await q('update variants set price_cents = 3500 where id = $1', [v.jerseyL]);
    const late = await deliveredOrder([{ variantId: v.jerseyM, qty: 1 }], 31);
    const closed = await ask({ orderNumber: late.number, resolution: 'size_exchange', items: [{ orderItemId: late.items[0].id, qty: 1, reason: 'x', exchangeVariantId: v.jerseyL }] }).expect(400);
    expect(closed.body.error.details[0].reason).toBe('window_closed');
  });
});

describe('what cannot be returned', () => {
  it('refuses printed shirts, socks, repeat requests and undelivered or foreign orders', async () => {
    const order = await deliveredOrder([
      { variantId: v.jerseyM, qty: 1, customPrint: { name: 'DARA', number: 10, patch: 'none' } },
      { variantId: v.socks, qty: 1 },
      { variantId: v.jerseyL, qty: 1 },
    ]);
    const byVariant = (id: string, printed = false) =>
      order.items.find((i: { variant_id: string; id: string }) => i.variant_id === id && (printed ? true : true))!.id;
    const printed = (await q('select id from order_items where custom_print is not null')).rows[0].id;
    const res = await ask({
      orderNumber: order.number,
      resolution: 'refund',
      items: [
        { orderItemId: printed, qty: 1, reason: 'x' },
        { orderItemId: byVariant(v.socks), qty: 1, reason: 'x' },
      ],
    }).expect(400);
    expect(res.body.error.details.map((d: { reason: string }) => d.reason).sort()).toEqual(['custom_print', 'non_returnable']);

    const plain = byVariant(v.jerseyL);
    await ask({ orderNumber: order.number, resolution: 'refund', items: [{ orderItemId: plain, qty: 1, reason: 'x' }] }).expect(201);
    const again = await ask({ orderNumber: order.number, resolution: 'refund', items: [{ orderItemId: plain, qty: 1, reason: 'x' }] }).expect(400);
    expect(again.body.error.details[0].reason).toBe('qty_exceeded');

    await q("update orders set status = 'confirmed', delivered_at = null");
    const notYet = await ask({ orderNumber: order.number, resolution: 'refund', items: [{ orderItemId: plain, qty: 1, reason: 'x' }] }).expect(400);
    expect(notYet.body.error.details[0].reason).toBe('not_delivered');

    const stranger = ctx.fake.token({ uid: 'rma-stranger', phone: '+85512006666' });
    await ask({ orderNumber: order.number, resolution: 'refund', items: [{ orderItemId: plain, qty: 1, reason: 'x' }] }, stranger).expect(404);
  });
});

describe('listing and staff scope', () => {
  it('lists my returns and keeps other branches’ staff out', async () => {
    const order = await deliveredOrder([{ variantId: v.jerseyM, qty: 1 }]);
    const created = await ask({ orderNumber: order.number, resolution: 'store_credit', items: [{ orderItemId: order.items[0].id, qty: 1, reason: 'Gift' }] }).expect(201);
    const mine = await request(ctx.app).get('/v1/me/returns').set(bearer(member)).expect(200);
    expect(mine.body.returns.map((r: { number: string }) => r.number)).toEqual([created.body.return.number]);
    const sensok = await staffToken(ctx.app, database, ctx.fake, 'rma-sensok', 'staff', 'sensok');
    await request(ctx.app).post(`/v1/admin/returns/${created.body.return.number}/decision`).set(bearer(sensok)).send({ decision: 'approve' }).expect(404);
    const list = await request(ctx.app).get('/v1/admin/returns?status=requested').set(bearer(admin)).expect(200);
    expect(list.body.total).toBe(1);
    await request(ctx.app).post(`/v1/admin/returns/${created.body.return.number}/decision`).set(bearer(admin)).send({ decision: 'approve' }).expect(200);
    const events = await q("select note from order_events where kind = 'flag'");
    expect(events.rows.some((e) => /store credit/i.test(e.note))).toBe(true);
  });
});
