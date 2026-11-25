import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { deliveryRate, findPromotion, loadRules, tierFor } from '../../src/modules/pricing/context.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const now = new Date('2026-12-01T00:00:00Z');

beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetDb(database);
  await seed(database.db);
  await q("update branches set pickup_enabled = true");
});

describe('findPromotion', () => {
  it('finds codes regardless of case and spaces', async () => {
    const r = await findPromotion(database.db, ' castle10 ', now);
    expect(r).toEqual({ promotionId: expect.any(String), promotion: { code: 'CASTLE10', name: '10% off', type: 'percent', value: 10, minSubtotalCents: 0, scope: {} } });
  });

  it('explains unknown, expired, future and used-up codes', async () => {
    await q(`insert into promotions (code, name, type, value, ends_at) values ('OLD', 'Old', 'percent', 5, '2026-01-01')`);
    await q(`insert into promotions (code, name, type, value, starts_at) values ('SOON', 'Soon', 'percent', 5, '2027-01-01')`);
    await q(`insert into promotions (code, name, type, value, max_uses, used_count) values ('GONE', 'Gone', 'percent', 5, 10, 10)`);
    await q(`insert into promotions (code, name, type, value, active) values ('OFF', 'Off', 'percent', 5, false)`);
    expect(await findPromotion(database.db, 'nope', now)).toEqual({ rejectedMessage: "We don't recognise that code" });
    expect(await findPromotion(database.db, 'old', now)).toEqual({ rejectedMessage: 'That code has expired' });
    expect(await findPromotion(database.db, 'soon', now)).toEqual({ rejectedMessage: "That code isn't active yet" });
    expect(await findPromotion(database.db, 'gone', now)).toEqual({ rejectedMessage: 'That code has been fully used' });
    expect(await findPromotion(database.db, 'off', now)).toEqual({ rejectedMessage: 'That code has expired' });
  });
});

describe('deliveryRate', () => {
  it('prices Phnom Penh rider delivery only inside Phnom Penh', async () => {
    expect(await deliveryRate(database.db, { fulfillment: 'delivery', methodId: 'pp_rider', provinceCode: '12' })).toEqual({
      fulfillment: 'delivery',
      methodId: 'pp_rider',
      rate: { feeCents: 250, freeOverCents: 5000 },
    });
    expect((await deliveryRate(database.db, { fulfillment: 'delivery', methodId: 'pp_rider', provinceCode: '17' })).rate).toBeNull();
  });

  it('prices the courier outside Phnom Penh only', async () => {
    expect((await deliveryRate(database.db, { fulfillment: 'delivery', methodId: 'province_courier', provinceCode: '17' })).rate).toEqual({
      feeCents: 300,
      freeOverCents: null,
    });
    expect((await deliveryRate(database.db, { fulfillment: 'delivery', methodId: 'province_courier', provinceCode: '12' })).rate).toBeNull();
  });

  it('prefers a province-specific rate over the default', async () => {
    await q(`insert into shipping_rates (method_id, province_code, fee_cents) values ('province_courier', '17', 450)`);
    expect((await deliveryRate(database.db, { fulfillment: 'delivery', methodId: 'province_courier', provinceCode: '17' })).rate).toEqual({
      feeCents: 450,
      freeOverCents: null,
    });
    await q(`delete from shipping_rates where method_id = 'province_courier' and province_code = '17'`);
  });

  it('allows pickup only at branches that offer it', async () => {
    expect((await deliveryRate(database.db, { fulfillment: 'pickup', pickupBranchId: 'sensok' })).rate).toEqual({ feeCents: 0, freeOverCents: null });
    await q("update branches set pickup_enabled = false where id = 'sensok'");
    expect((await deliveryRate(database.db, { fulfillment: 'pickup', pickupBranchId: 'sensok' })).rate).toBeNull();
    expect((await deliveryRate(database.db, { fulfillment: 'pickup' })).rate).toBeNull();
  });

  it('rejects unknown methods', async () => {
    expect((await deliveryRate(database.db, { fulfillment: 'delivery', methodId: 'drone', provinceCode: '12' })).rate).toBeNull();
  });
});

describe('loadRules and tierFor', () => {
  it('reads the rules from settings', async () => {
    const rules = await loadRules(database.db);
    expect(rules.khrRate).toBe(4100);
    expect(rules.team).toEqual({ minItems: 5, percent: 10, categories: ['jerseys', 'f1'] });
    expect(rules.printFees.baseCents).toBe(800);
  });

  it('gives perks only to members with a verified phone', async () => {
    const withPhone = (await q("insert into users (firebase_uid, phone_e164) values ('a', '+85512345678') returning *")).rows[0];
    const noPhone = (await q("insert into users (firebase_uid, email) values ('b', 'b@x.com') returning *")).rows[0];
    await q("insert into loyalty_accounts (user_id, tier) values ($1, 'silver'), ($2, 'gold')", [withPhone.id, noPhone.id]);
    expect(await tierFor(database.db, { id: withPhone.id, phoneE164: withPhone.phone_e164 })).toBe('silver');
    expect(await tierFor(database.db, { id: noPhone.id, phoneE164: null })).toBeNull();
    expect(await tierFor(database.db, undefined)).toBeNull();
    const fresh = (await q("insert into users (firebase_uid, phone_e164) values ('c', '+85599999999') returning *")).rows[0];
    expect(await tierFor(database.db, { id: fresh.id, phoneE164: fresh.phone_e164 })).toBe('bronze');
  });
});
