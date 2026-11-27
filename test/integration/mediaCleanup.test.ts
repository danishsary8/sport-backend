import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { cleanupUnusedMedia } from '../../src/jobs/sweeper.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const upload = async (hoursAgo: number) =>
  (await q(`insert into media_files (content_type, bytes, size, created_at) values ('image/png', '\\x89', 1, now() - ($1 || ' hours')::interval) returning id`, [String(hoursAgo)])).rows[0].id as string;
const exists = async (id: string) => (await q('select 1 from media_files where id = $1', [id])).rowCount === 1;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q("delete from product_images where path like 'media/%'");
  await q('delete from media_files');
});

describe('cleanupUnusedMedia', () => {
  it('deletes old uploads nothing uses and keeps recent ones', async () => {
    const old = await upload(30);
    const fresh = await upload(2);
    expect(await cleanupUnusedMedia(database, new Date())).toBe(1);
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('keeps old uploads used by a product photo, a brand logo or a past order', async () => {
    const onProduct = await upload(48);
    const onBrand = await upload(48);
    const onOrder = await upload(48);
    const [p] = (await q('select id from products limit 1')).rows;
    await q('insert into product_images (product_id, path, sort) values ($1, $2, 99)', [p.id, `media/${onProduct}.png`]);
    const [b] = (await q('select id, logo_path from brands limit 1')).rows;
    await q('update brands set logo_path = $2 where id = $1', [b.id, `media/${onBrand}.webp`]);
    const [v] = (await q('select id from variants limit 1')).rows;
    const [o] = (
      await q(
        `insert into orders (number, contact_name, contact_phone_e164, contact_channel, fulfillment, status, payment_status, payment_method,
           merchandise_cents, discount_cents, shipping_cents, total_cents, khr_rate, total_khr, pricing)
         values ('SC-2611-MC001', 'A', '+85512345678', 'phone', 'delivery', 'confirmed', 'paid', 'aba_khqr', 100, 0, 0, 100, 4100, 0, '{}') returning id`,
      )
    ).rows;
    await q(`insert into order_items (order_id, variant_id, product_snapshot, unit_price_cents, line_total_cents, qty) values ($1, $2, $3, 100, 100, 1)`, [
      o.id,
      v.id,
      JSON.stringify({ imagePath: `media/${onOrder}.jpg` }),
    ]);
    try {
      expect(await cleanupUnusedMedia(database, new Date())).toBe(0);
      for (const id of [onProduct, onBrand, onOrder]) expect(await exists(id)).toBe(true);
    } finally {
      await q('update brands set logo_path = $2 where id = $1', [b.id, b.logo_path]);
      await q('delete from orders where id = $1', [o.id]);
    }
  });
});
