import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
});
afterAll(closeTestDb);

describe('post-purchase schema', () => {
  it('seeds the return rules', async () => {
    expect((await q("select value from settings where key = 'return_rules'")).rows[0].value).toEqual({ exchangeDays: 30, refundDays: 14, nonReturnable: ['socks', 'underwear'] });
  });

  it('checks question status and return quantities, and accepts the cancel ledger reason', async () => {
    const productId = (await q('select id from products limit 1')).rows[0].id;
    expect(await pgError(q(`insert into product_questions (product_id, author_name, question, status) values ($1, 'A', 'Is it true to size?', 'spam')`, [productId]))).toBe('23514');
    const userId = (await q(`insert into users (firebase_uid, full_name) values ('pp-schema', 'P') returning id`)).rows[0].id;
    const orderId = (
      await q(
        `insert into orders (number, user_id, contact_name, contact_phone_e164, contact_channel, fulfillment, status, payment_method, merchandise_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, pricing)
         values ('SC-2611-PPSCH', $1, 'P', '+85512345678', 'phone', 'delivery', 'delivered', 'aba_khqr', 1000, 0, 0, 1000, 4100, 41000, '{}') returning id`,
        [userId],
      )
    ).rows[0].id;
    const variantId = (await q('select id from variants limit 1')).rows[0].id;
    const itemId = (await q(`insert into order_items (order_id, variant_id, product_snapshot, unit_price_cents, line_total_cents, qty) values ($1, $2, '{}', 1000, 1000, 1) returning id`, [orderId, variantId])).rows[0].id;
    const rmaId = (await q(`insert into rma_requests (number, order_id, user_id, resolution, status) values ('RMA-2611-AAAAA', $1, $2, 'refund', 'requested') returning id`, [orderId, userId])).rows[0].id;
    expect(await pgError(q(`insert into rma_items (rma_id, order_item_id, qty, reason) values ($1, $2, 0, 'too big')`, [rmaId, itemId]))).toBe('23514');
    await q(`insert into loyalty_ledger (user_id, delta, reason, order_id) values ($1, -10, 'order_cancelled', $2)`, [userId, orderId]);
    expect((await q('select delivered_at from orders where id = $1', [orderId])).rows[0].delivered_at).toBeNull();
  });
});
