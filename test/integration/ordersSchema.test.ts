import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';
import { withCatalog } from '../helpers/catalog.js';

let database: Database;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const setting = async (key: string) => (await q('select value from settings where key = $1', [key])).rows[0]?.value;

async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

const ORDER_COLS = `number, contact_name, contact_phone_e164, contact_channel, fulfillment, pickup_branch_id, status, payment_method,
  merchandise_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, pricing`;
let seq = 0;
function insertOrder(over: Partial<Record<string, unknown>> = {}) {
  seq += 1;
  const o = {
    number: `SC-2611-T${String(seq).padStart(4, '0')}`,
    fulfillment: 'delivery',
    pickup_branch_id: null,
    status: 'pending_payment',
    merchandise: 5000,
    discount: 0,
    shipping: 250,
    total: 5250,
    ...over,
  };
  return q(
    `insert into orders (${ORDER_COLS}) values ($1, 'Dara', '+85512345678', 'telegram', $2, $3, $4, 'aba_khqr', $5, $6, $7, $8, 4100, 215300, '{}') returning id`,
    [o.number, o.fulfillment, o.pickup_branch_id, o.status, o.merchandise, o.discount, o.shipping, o.total],
  );
}

beforeAll(async () => {
  database = await testDb();
  await resetDb(database);
  await withCatalog(database);
});
afterAll(closeTestDb);

describe('checkout settings', () => {
  it('seeds payment methods, reservation time and cash-on-pickup hold', async () => {
    expect(await setting('payment_methods_enabled')).toEqual({ aba_khqr: true, card: true, acleda: false, wing: false, cash_on_pickup: false });
    expect(await setting('reservation_minutes')).toEqual({ minutes: 30 });
    expect(await setting('cash_on_pickup_hours')).toEqual({ hours: 48 });
  });
});

describe('order constraints', () => {
  it('accepts a consistent order', async () => {
    expect((await insertOrder()).rows[0].id).toBeTruthy();
  });

  it('rejects a total that does not add up', async () => {
    expect(await pgError(insertOrder({ total: 9999 }))).toBe('23514');
  });

  it('rejects a pickup order without a branch', async () => {
    expect(await pgError(insertOrder({ fulfillment: 'pickup', shipping: 0, total: 5000 }))).toBe('23514');
  });

  it('rejects an unknown status', async () => {
    expect(await pgError(insertOrder({ status: 'teleported' }))).toBe('23514');
  });

  it('rejects an order item whose line total does not match', async () => {
    const orderId = (await insertOrder()).rows[0].id;
    const variantId = (await q('select id from variants limit 1')).rows[0].id;
    const insertItem = (lineTotal: number) =>
      q(
        `insert into order_items (order_id, variant_id, product_snapshot, unit_price_cents, print_fee_cents, discount_cents, line_total_cents, qty)
         values ($1, $2, '{}', 2500, 0, 0, $3, 2)`,
        [orderId, variantId, lineTotal],
      );
    expect(await pgError(insertItem(4000))).toBe('23514');
    await insertItem(5000);
  });
});

describe('payments and ledgers', () => {
  it('keeps provider transaction ids unique', async () => {
    const orderId = (await insertOrder()).rows[0].id;
    const pay = (attempt: number) =>
      q(`insert into payments (order_id, attempt, provider, provider_tran_id, method, amount_cents, status) values ($1, $2, 'payway', 'SC2611X-1', 'aba_khqr', 5250, 'pending')`, [
        orderId,
        attempt,
      ]);
    await pay(1);
    expect(await pgError(pay(2))).toBe('23505');
  });

  it('stores each webhook event once per provider', async () => {
    const ev = () => q(`insert into payment_webhook_events (provider, event_id, signature_valid, processing_status, payload) values ('payway', 'e1', true, 'received', '{}')`);
    await ev();
    expect(await pgError(ev())).toBe('23505');
  });

  it('awards order points at most once per order', async () => {
    const orderId = (await insertOrder()).rows[0].id;
    const userId = (await q(`insert into users (firebase_uid, full_name) values ('u-ledger', 'L') returning id`)).rows[0].id;
    const award = () => q(`insert into loyalty_ledger (user_id, delta, reason, order_id) values ($1, 500, 'order_paid', $2)`, [userId, orderId]);
    await award();
    expect(await pgError(award())).toBe('23505');
  });
});
