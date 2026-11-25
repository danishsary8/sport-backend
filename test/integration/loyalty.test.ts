import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { BOOT, guestOrder, idem, JERSEY, payOrder, phnomPenhAddress, staffToken, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
const v = {} as Record<'jersey' | 'boot', string>;
let member: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const userId = async (uid: string) => (await q('select id from users where firebase_uid = $1', [uid])).rows[0].id as string;

async function order(lines: { variantId: string; qty: number }[], pay = true) {
  for (const line of lines) await request(ctx.app).post('/v1/cart/items').set(bearer(member)).send(line).expect(200);
  const placed = await request(ctx.app).post('/v1/orders').set(bearer(member)).set(idem()).send(guestOrder(address)).expect(201);
  if (pay) await payOrder(ctx.app, placed.body.payment.tranId);
  return placed.body.order.number as string;
}

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  v.jersey = await variantId(database, JERSEY, 'M');
  v.boot = await variantId(database, BOOT);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await q('delete from loyalty_ledger');
  await q('delete from loyalty_accounts');
  await setProductStock(database, JERSEY, 10);
  await setProductStock(database, BOOT, 10);
  ctx = memberApp(database);
  member = ctx.fake.token({ uid: 'loyal-member', phone: '+85512007777' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(member)).expect(200);
});

describe('GET /v1/me/loyalty', () => {
  it('starts a new member at bronze with the next tier ahead', async () => {
    const res = await request(ctx.app).get('/v1/me/loyalty').set(bearer(member)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ pointsBalance: 0, tier: 'bronze', lifetimeSpendCents: 0, phoneVerified: true, nextTier: { id: 'silver', minSpendCents: 15000, remainingCents: 15000 }, ledger: [] });
    expect(res.body.perks).toEqual({});
  });

  it('shows silver perks and the way to gold', async () => {
    await q("insert into loyalty_accounts (user_id, lifetime_spend_cents, tier, points_balance) values ($1, 16000, 'silver', 1600)", [await userId('loyal-member')]);
    const res = await request(ctx.app).get('/v1/me/loyalty').set(bearer(member)).expect(200);
    expect(res.body).toMatchObject({ tier: 'silver', pointsBalance: 1600, nextTier: { id: 'gold', remainingCents: 14000 } });
    expect(res.body.perks).toEqual({ memberDiscountPercent: 10, memberDiscountCategories: ['boots', 'jerseys', 'f1', 'balls', 'essentials'] });
  });

  it('shows every perk at pro, with no next tier', async () => {
    await q("insert into loyalty_accounts (user_id, lifetime_spend_cents, tier) values ($1, 60000, 'pro')", [await userId('loyal-member')]);
    const res = await request(ctx.app).get('/v1/me/loyalty').set(bearer(member)).expect(200);
    expect(res.body.nextTier).toBeNull();
    expect(res.body.perks).toMatchObject({ memberDiscountPercent: 10, freeDelivery: ['pp_rider'], freePrinting: true });
  });

  it('tells a Google-only member to add a phone', async () => {
    const google = ctx.fake.token({ uid: 'loyal-google', email: 'g@example.com' });
    const res = await request(ctx.app).get('/v1/me/loyalty').set(bearer(google)).expect(200);
    expect(res.body.phoneVerified).toBe(false);
  });

  it('lists ledger entries with their order numbers', async () => {
    const number = await order([{ variantId: v.jersey, qty: 1 }]);
    const res = await request(ctx.app).get('/v1/me/loyalty').set(bearer(member)).expect(200);
    expect(res.body.ledger[0]).toMatchObject({ reason: 'order_paid', orderNumber: number });
    expect(res.body.ledger[0].delta).toBeGreaterThan(0);
  });
});

describe('GET /v1/me/insights', () => {
  it('summarises paid orders only', async () => {
    await order([{ variantId: v.jersey, qty: 2 }]);
    await order([{ variantId: v.boot, qty: 1 }]);
    await order([{ variantId: v.boot, qty: 1 }], false);
    const res = await request(ctx.app).get('/v1/me/insights').set(bearer(member)).expect(200);
    expect(res.body).toMatchObject({ totalOrders: 2, totalItems: 3, customPrintedCount: 0 });
    const shares = res.body.categories.reduce((s: number, c: { sharePct: number }) => s + c.sharePct, 0);
    expect(Math.abs(shares - 100)).toBeLessThanOrEqual(1);
    expect(res.body.categories.map((c: { key: string }) => c.key).sort()).toEqual(['boots', 'jerseys']);
    expect(res.body.favoriteCategory.key).toBe(res.body.categories[0].key);
    expect(res.body.brands.length).toBeGreaterThan(0);
  });
});

describe('admin point adjustments', () => {
  it('lets an admin add or remove points with a note, never below zero', async () => {
    const admin = await staffToken(ctx.app, database, ctx.fake, 'loyal-admin', 'admin');
    const staff = await staffToken(ctx.app, database, ctx.fake, 'loyal-staff', 'staff');
    const id = await userId('loyal-member');
    await request(ctx.app).post(`/v1/admin/users/${id}/loyalty`).set(bearer(staff)).send({ delta: 500, note: 'x' }).expect(403);
    await request(ctx.app).post(`/v1/admin/users/${id}/loyalty`).set(bearer(admin)).send({ delta: 0, note: 'x' }).expect(400);
    const added = await request(ctx.app).post(`/v1/admin/users/${id}/loyalty`).set(bearer(admin)).send({ delta: 500, note: 'Birthday gift' }).expect(200);
    expect(added.body.pointsBalance).toBe(500);
    expect((await q("select delta, note from loyalty_ledger where reason = 'admin'")).rows).toEqual([{ delta: 500, note: 'Birthday gift' }]);
    const tooMuch = await request(ctx.app).post(`/v1/admin/users/${id}/loyalty`).set(bearer(admin)).send({ delta: -501, note: 'Oops' }).expect(409);
    expect(tooMuch.body.error.code).toBe('insufficient_points');
    await request(ctx.app).post(`/v1/admin/users/${id}/loyalty`).set(bearer(admin)).send({ delta: -500, note: 'Correction' }).expect(200);
  });
});
