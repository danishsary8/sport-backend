import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const setting = async (key: string) => (await q('select value from settings where key = $1', [key])).rows[0]?.value;

beforeAll(async () => {
  database = await testDb();
  await resetDb(database);
  await seed(database.db);
});
afterAll(closeTestDb);

describe('commerce reference data', () => {
  it('seeds delivery methods and rates', async () => {
    expect((await q('select id from shipping_methods order by sort')).rows.map((r) => r.id)).toEqual(['pp_rider', 'province_courier', 'pickup']);
    const pp = (await q("select fee_cents, free_over_cents from shipping_rates where method_id = 'pp_rider' and province_code = '12'")).rows[0];
    expect(pp).toEqual({ fee_cents: 250, free_over_cents: 5000 });
    const courier = (await q("select fee_cents, needs_review from shipping_rates where method_id = 'province_courier' and province_code is null")).rows[0];
    expect(courier).toEqual({ fee_cents: 300, needs_review: true });
  });

  it('seeds the storefront promo codes', async () => {
    const promos = (await q('select code, type, value, scope from promotions order by code')).rows;
    expect(promos).toEqual([
      { code: 'CASTLE10', type: 'percent', value: 10, scope: {} },
      { code: 'PPFREE', type: 'free_shipping', value: 0, scope: { methods: ['pp_rider'] } },
    ]);
  });

  it('seeds the pricing rules with today’s storefront values', async () => {
    expect(await setting('khr_rate')).toEqual({ rate: 4100 });
    expect(await setting('custom_print_fees')).toEqual({
      baseCents: 800,
      patches: { none: 0, ucl: 500, cpl: 400, aff: 400, champions: 500, 'f1-paddock': 500 },
    });
    expect(await setting('team_discount_rule')).toEqual({ minItems: 5, percent: 10, categories: ['jerseys', 'f1'] });
    const loyalty = await setting('loyalty_rules');
    expect(loyalty.pointsPerUsd).toBe(10);
    expect(loyalty.tiers).toEqual([
      { id: 'bronze', minSpendCents: 0 },
      { id: 'silver', minSpendCents: 15000 },
      { id: 'gold', minSpendCents: 30000 },
      { id: 'pro', minSpendCents: 50000 },
    ]);
    expect(loyalty.memberDiscount).toEqual({ fromTier: 'silver', percent: 10, categories: ['boots', 'jerseys', 'f1', 'balls', 'essentials'] });
    expect(loyalty.freeDelivery).toEqual({ fromTier: 'gold', methods: ['pp_rider'] });
    expect(loyalty.freePrinting).toEqual({ fromTier: 'pro' });
  });

  it('keeps admin changes when seeding again', async () => {
    await q(`update settings set value = '{"rate":4050}' where key = 'khr_rate'`);
    try {
      await seed(database.db);
      expect(await setting('khr_rate')).toEqual({ rate: 4050 });
    } finally {
      await q(`update settings set value = '{"rate":4100}' where key = 'khr_rate'`);
    }
    expect((await q('select count(*)::int as n from promotions')).rows[0].n).toBe(2);
    expect((await q('select count(*)::int as n from shipping_rates')).rows[0].n).toBe(3);
  });
});

describe('cart and promotion constraints', () => {
  it('requires a cart to belong to exactly one of a user or a guest', async () => {
    await expect(q('insert into carts (user_id, guest_token) values (null, null)')).rejects.toThrow();
    const user = (await q("insert into users (firebase_uid) values ('c1') returning id")).rows[0].id;
    await expect(q("insert into carts (user_id, guest_token) values ($1, 'tok')", [user])).rejects.toThrow();
    await expect(q("insert into carts (guest_token) values ('tok-ok')")).resolves.toBeDefined();
  });

  it('bounds line quantities', async () => {
    const cart = (await q("insert into carts (guest_token) values ('tok-q') returning id")).rows[0].id;
    const variant = await q('select id from variants limit 1');
    if (variant.rows.length === 0) return; // no catalog in this file: quantity check covered by the constraint test below
    await expect(q('insert into cart_items (cart_id, variant_id, qty) values ($1, $2, 0)', [cart, variant.rows[0].id])).rejects.toThrow();
  });

  it('rejects impossible percentages', async () => {
    await expect(q("insert into promotions (code, name, type, value) values ('BAD', 'Bad', 'percent', 150)")).rejects.toThrow();
  });

  it('has the quantity check on cart items', async () => {
    const r = await q("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'cart_items_qty_check'");
    expect(r.rows[0]?.def).toMatch(/qty >= 1.*qty <= 20/);
  });
});
