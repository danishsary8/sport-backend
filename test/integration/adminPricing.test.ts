import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { loadRules } from '../../src/modules/pricing/context.js';
import { bearer, memberApp } from '../helpers/app.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
let staff: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

/** Puts the shared pricing reference data back to the seeded defaults (other test files rely on it). */
async function restoreSharedPricing() {
  await q("delete from settings where key in ('khr_rate', 'custom_print_fees', 'team_discount_rule', 'loyalty_rules')");
  await seed(database.db);
  await q(`update shipping_rates set fee_cents = 200, needs_review = false where method_id = 'province_courier' and province_code is null`);
  await q(`delete from promotions where code not in ('CASTLE10', 'PPFREE')`);
}

beforeAll(async () => {
  database = await testDb();
  await resetDb(database);
  await seed(database.db);
  await restoreSharedPricing();
  ctx = memberApp(database);
  admin = ctx.fake.token({ uid: 'admin', phone: '+85511111111' });
  staff = ctx.fake.token({ uid: 'staff', phone: '+85522222222' });
  for (const t of [admin, staff]) await request(ctx.app).post('/v1/auth/session').set(bearer(t));
  await q("update users set role = 'admin' where firebase_uid = 'admin'");
  await q("update users set role = 'staff' where firebase_uid = 'staff'");
});
afterAll(async () => {
  // Shared reference data: put it back for other test files.
  await restoreSharedPricing();
  await closeTestDb();
});

const api = (method: 'get' | 'post' | 'patch' | 'put', path: string, token: string, body?: object) => {
  const r = request(ctx.app)[method](`/v1/admin${path}`).set(bearer(token));
  return body ? r.send(body) : r;
};

describe('admin pricing', () => {
  it('is admin-only', async () => {
    expect((await api('get', '/promotions', staff)).status).toBe(403);
    expect((await api('get', '/shipping-rates', staff)).status).toBe(403);
    expect((await api('get', '/settings/pricing', staff)).status).toBe(403);
  });

  it('creates and edits promotions with validation', async () => {
    expect((await api('post', '/promotions', admin, { code: 'zero', name: 'Zero', type: 'percent', value: 0 })).status).toBe(400);
    const created = await api('post', '/promotions', admin, { code: ' new15 ', name: 'New 15', type: 'percent', value: 15, minSubtotalCents: 3000 });
    expect(created.status).toBe(201);
    expect(created.body.promotion).toMatchObject({ code: 'NEW15', value: 15, active: true });
    expect((await api('post', '/promotions', admin, { code: 'NEW15', name: 'Again', type: 'percent', value: 5 })).status).toBe(409);
    const off = await api('patch', `/promotions/${created.body.promotion.id}`, admin, { active: false });
    expect(off.body.promotion.active).toBe(false);
    const list = await api('get', '/promotions', admin);
    expect(list.body.promotions.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(['CASTLE10', 'PPFREE', 'NEW15']));
  });

  it('updates delivery rates and clears the review flag', async () => {
    await q(`update shipping_rates set needs_review = true where method_id = 'province_courier' and province_code is null`);
    const rates = (await api('get', '/shipping-rates', admin)).body.rates;
    const courier = rates.find((r: { methodId: string }) => r.methodId === 'province_courier');
    expect(courier.needsReview).toBe(true);
    const res = await api('put', `/shipping-rates/${courier.id}`, admin, { feeCents: 350, freeOverCents: null });
    expect(res.status).toBe(200);
    expect(res.body.rate).toMatchObject({ feeCents: 350, needsReview: false });
    expect((await api('put', `/shipping-rates/${courier.id}`, admin, { feeCents: -1, freeOverCents: null })).status).toBe(400);
  });

  it('validates and applies pricing settings', async () => {
    expect((await api('put', '/settings/pricing/khr_rate', admin, { rate: -1 })).status).toBe(400);
    expect((await api('put', '/settings/pricing/unknown_key', admin, { rate: 1 })).status).toBe(404);
    expect((await api('put', '/settings/pricing/khr_rate', admin, { rate: 4000 })).status).toBe(200);
    expect((await loadRules(database.db)).khrRate).toBe(4000);
    const all = await api('get', '/settings/pricing', admin);
    expect(all.body.settings.khr_rate).toEqual({ rate: 4000 });
  });

  it('refuses loyalty tiers out of order or missing', async () => {
    const current = (await api('get', '/settings/pricing', admin)).body.settings.loyalty_rules;
    const reversed = { ...current, tiers: [...current.tiers].reverse() };
    expect((await api('put', '/settings/pricing/loyalty_rules', admin, reversed)).status).toBe(400);
    const duplicated = { ...current, tiers: current.tiers.map((t: { id: string }, i: number) => (i === 2 ? { ...t, id: 'silver' } : t)) };
    expect((await api('put', '/settings/pricing/loyalty_rules', admin, duplicated)).status).toBe(400);
    const flat = { ...current, tiers: current.tiers.map((t: object) => ({ ...t, minSpendCents: 0 })) };
    expect((await api('put', '/settings/pricing/loyalty_rules', admin, flat)).status).toBe(400);
  });

  it('refuses print fees that leave a patch unpriced, and a 0% team discount', async () => {
    const fees = { baseCents: 800, patches: { none: 0, cpl: 400, aff: 400, champions: 500, 'f1-paddock': 500 } };
    expect((await api('put', '/settings/pricing/custom_print_fees', admin, fees)).status).toBe(400);
    expect((await api('put', '/settings/pricing/team_discount_rule', admin, { minItems: 5, percent: 0, categories: ['jerseys'] })).status).toBe(400);
  });
});
