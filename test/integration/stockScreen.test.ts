import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { JERSEY, setStockAt, staffToken, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
let staff: string;
let jerseyM: string;
let jerseyL: string;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'stock-admin', 'admin', null);
  staff = await staffToken(ctx.app, database, ctx.fake, 'stock-staff', 'staff', 'sonthormuk');
  jerseyM = await variantId(database, JERSEY, 'M');
  jerseyL = await variantId(database, JERSEY, 'L');
});
afterAll(closeTestDb);
beforeEach(async () => {
  await database.pool.query('update stock set needs_count = false');
  // With the default safety buffer of 1, three on the shelf leaves 2 to sell online: running low.
  await setStockAt(database, jerseyM, { sonthormuk: 3 });
  await setStockAt(database, jerseyL, { sonthormuk: 0 });
});

const list = (token: string, query: Record<string, string>) => request(ctx.app).get('/v1/admin/stock/list').query(query).set(bearer(token));

describe('stock screen list', () => {
  it('lists products with every size at the branch, and the filter counts', async () => {
    const res = await list(admin, { branchId: 'sonthormuk', q: 'varaman' }).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    const product = res.body.products.find((p: { slug: string }) => p.slug === JERSEY);
    expect(product).toMatchObject({ slug: JERSEY, status: expect.any(String) });
    expect(product.variants.find((v: { id: string }) => v.id === jerseyM)).toMatchObject({ onHand: 3, available: 3, low: true, needsCount: false });
    expect(res.body.counts.all).toBe(res.body.total);
    expect(res.body.counts.low).toBeGreaterThanOrEqual(1);
    expect(res.body.counts.out).toBeGreaterThanOrEqual(1);
  });

  it('filters to low, sold out and waiting-to-count sizes', async () => {
    await database.pool.query("update stock set needs_count = true where variant_id = $1 and branch_id = 'sonthormuk'", [jerseyL]);
    for (const view of ['low', 'out', 'count']) {
      const res = await list(admin, { branchId: 'sonthormuk', view, q: 'varaman' }).expect(200);
      expect(res.body.products.map((p: { slug: string }) => p.slug)).toContain(JERSEY);
    }
    await setStockAt(database, jerseyM, { sonthormuk: 9 });
    const low = await list(admin, { branchId: 'sonthormuk', view: 'low', q: 'varaman' }).expect(200);
    expect(low.body.products.find((p: { slug: string }) => p.slug === JERSEY)?.variants.find((v: { id: string }) => v.id === jerseyM)?.low ?? false).toBe(false);
  });

  it('pages through products', async () => {
    const one = await list(admin, { branchId: 'sonthormuk', pageSize: '1', page: '2' }).expect(200);
    expect(one.body.products).toHaveLength(1);
    expect(one.body.total).toBeGreaterThan(1);
  });

  it('keeps branch staff to their own branch', async () => {
    await list(staff, { branchId: 'sensok' }).expect(403);
    const own = await list(staff, {}).expect(200);
    expect(own.body.branchId).toBe('sonthormuk');
  });
});

describe('set count', () => {
  it('replaces the number on the shelf, logs the difference and clears the count flag', async () => {
    await database.pool.query("update stock set needs_count = true where variant_id = $1 and branch_id = 'sonthormuk'", [jerseyM]);
    const res = await request(ctx.app).post('/v1/admin/stock/count').set(bearer(staff)).send({ variantId: jerseyM, branchId: 'sonthormuk', count: 5 }).expect(200);
    expect(res.body).toMatchObject({ delta: 2, stock: { onHand: 5, needsCount: false } });
    const moves = await database.pool.query("select delta_on_hand, note from stock_movements where variant_id = $1 and reason = 'admin_adjust' order by id desc limit 1", [jerseyM]);
    expect(moves.rows[0]).toEqual({ delta_on_hand: 2, note: 'Counted' });
  });

  it('clears the flag without a movement when the count matches', async () => {
    await database.pool.query("update stock set needs_count = true where variant_id = $1 and branch_id = 'sonthormuk'", [jerseyM]);
    const before = (await database.pool.query('select count(*)::int as n from stock_movements where variant_id = $1', [jerseyM])).rows[0].n;
    const res = await request(ctx.app).post('/v1/admin/stock/count').set(bearer(admin)).send({ variantId: jerseyM, branchId: 'sonthormuk', count: 3 }).expect(200);
    expect(res.body).toMatchObject({ delta: 0, stock: { onHand: 3, needsCount: false } });
    expect((await database.pool.query('select count(*)::int as n from stock_movements where variant_id = $1', [jerseyM])).rows[0].n).toBe(before);
  });

  it('refuses a count below what online orders hold', async () => {
    await database.pool.query("update stock set reserved = 2 where variant_id = $1 and branch_id = 'sonthormuk'", [jerseyM]);
    const res = await request(ctx.app).post('/v1/admin/stock/count').set(bearer(admin)).send({ variantId: jerseyM, branchId: 'sonthormuk', count: 1 }).expect(409);
    expect(res.body.error.code).toBe('held_for_online_order');
  });
});

describe('restock', () => {
  const restock = (token: string, body: object) => request(ctx.app).post('/v1/admin/stock/restock').set(bearer(token)).send(body);

  it('adds the same amount to every chosen size, as one delivery in the history', async () => {
    const res = await restock(staff, { branchId: 'sonthormuk', lines: [{ variantId: jerseyM, qty: 5 }, { variantId: jerseyL, qty: 5 }], note: 'Supplier delivery' }).expect(200);
    expect(res.body).toMatchObject({ sizes: 2, units: 10, refId: expect.stringMatching(/^RESTOCK-/) });
    const rows = await database.pool.query("select variant_id, on_hand from stock where branch_id = 'sonthormuk' and variant_id = any($1)", [[jerseyM, jerseyL]]);
    expect(Object.fromEntries(rows.rows.map((r) => [r.variant_id, r.on_hand]))).toEqual({ [jerseyM]: 8, [jerseyL]: 5 });
    const moves = await database.pool.query("select ref_id, note, delta_on_hand from stock_movements where reason = 'restock' and ref_id = $1", [res.body.refId]);
    expect(moves.rows).toHaveLength(2);
    expect(moves.rows.every((m) => m.note === 'Supplier delivery' && m.delta_on_hand === 5)).toBe(true);
  });

  it('applies nothing when one size is unknown', async () => {
    await restock(admin, { branchId: 'sonthormuk', lines: [{ variantId: jerseyM, qty: 2 }, { variantId: '00000000-0000-4000-8000-000000000000', qty: 2 }] }).expect(404);
    expect((await database.pool.query("select on_hand from stock where branch_id = 'sonthormuk' and variant_id = $1", [jerseyM])).rows[0].on_hand).toBe(3);
  });

  it('keeps branch staff to their own branch', async () => {
    await restock(staff, { branchId: 'sensok', lines: [{ variantId: jerseyM, qty: 1 }] }).expect(403);
  });
});
