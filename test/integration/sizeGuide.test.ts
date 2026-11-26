import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalog } from '../../src/contracts/index.js';
import type { Database } from '../../src/db/client.js';
import { memberApp } from '../helpers/app.js';
import { BOOT, JERSEY } from '../helpers/checkout.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  ctx = memberApp(database);
});
afterAll(closeTestDb);

describe('size guides', () => {
  it('shows the boot chart on a boot page', async () => {
    const res = await request(ctx.app).get(`/v1/catalog/products/${BOOT}`).expect(200);
    const guide = res.body.product.sizeGuide;
    expect(guide.columns).toEqual(['EU', 'UK', 'US', 'Foot length (cm)']);
    expect(guide.rows.find((r: string[]) => r[0] === '42')).toBeTruthy();
    expect(catalog.productDetailResponse.safeParse(res.body).success).toBe(true);
  });

  it('shows the shirt chart on a jersey page', async () => {
    const res = await request(ctx.app).get(`/v1/catalog/products/${JERSEY}`).expect(200);
    expect(res.body.product.sizeGuide.rows.map((r: string[]) => r[0])).toEqual(['S', 'M', 'L', 'XL', 'XXL']);
  });

  it('can be changed by the shop without a deploy', async () => {
    const before = (await database.pool.query("select value from settings where key = 'size_guides'")).rows[0].value;
    try {
      await database.pool.query("update settings set value = jsonb_set(value, '{jerseys,note}', '{\"en\":\"Runs small\"}') where key = 'size_guides'");
      const res = await request(ctx.app).get(`/v1/catalog/products/${JERSEY}`).expect(200);
      expect(res.body.product.sizeGuide.note).toBe('Runs small');
    } finally {
      await database.pool.query("update settings set value = $1 where key = 'size_guides'", [JSON.stringify(before)]);
    }
  });
});
