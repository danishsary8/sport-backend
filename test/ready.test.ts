import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb } from './setup/test-app.js';

const { app, db, pool } = buildTestApp();
afterAll(() => pool.end());

describe('readiness and schema', () => {
  it('GET /ready → 200 when the database answers', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });

  it('GET /ready → 503 problem when the database check fails', async () => {
    const broken = buildTestApp({ checkDb: async () => { throw new Error('down'); } });
    const res = await request(broken.app).get('/ready');
    await broken.pool.end();
    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/service-unavailable$/);
  });

  it('GET /ready → 503 within 3 s when the database is unreachable', async () => {
    const { createDb } = await import('../src/db/client.js');
    const unreachable = createDb('postgres://postgres:postgres@127.0.0.1:1/nope');
    const broken = buildTestApp({ db: unreachable.db, checkDb: undefined });
    const started = Date.now();
    const res = await request(broken.app).get('/ready');
    await Promise.all([broken.pool.end(), unreachable.pool.end()]);
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('migrations created products and product_stock', async () => {
    const result = await db.execute(
      sql`select to_regclass('public.products') as p, to_regclass('public.product_stock') as s`,
    );
    expect(result.rows[0]).toEqual({ p: 'products', s: 'product_stock' });
  });

  it('rejects negative stock at the database level', async () => {
    await resetDb(db);
    const inserted = await db.execute(sql`
      insert into products (slug, name, short_name, brand, brand_slug, category, price_cents, media)
      values ('t-shirt', 'T', 'T', 'Nike', 'nike', 'jerseys', 1000, '{"front":"/x.jpg"}') returning id`);
    const id = inserted.rows[0]!.id as string;
    const error = await db
      .execute(sql`insert into product_stock (product_id, branch, size, quantity) values (${id}, 'sensok', 'M', -1)`)
      .then(() => null, (e: { cause?: { code?: string; constraint?: string } }) => e.cause);
    expect(error).toMatchObject({ code: '23514', constraint: 'product_stock_quantity_non_negative' });
  });
});
