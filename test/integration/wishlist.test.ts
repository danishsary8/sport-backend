import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let alice: string;
let bob: string;
const JERSEY = 'cambodia-national-team-home-jersey-varaman';
const BOOT = 'adidas-f50-elite-messi-signature-edition-fg';
let jerseyId: string;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  jerseyId = (await database.pool.query('select id from products where slug = $1', [JERSEY])).rows[0].id;
});
afterAll(closeTestDb);
beforeEach(async () => {
  await database.pool.query('delete from wishlist_items');
  await database.pool.query("update products set status = 'active'");
  await setProductStock(database, JERSEY, 10);
  ctx = memberApp(database);
  alice = ctx.fake.token({ uid: 'alice', phone: '+85512345678' });
  bob = ctx.fake.token({ uid: 'bob', phone: '+85596889217' });
});

const add = (token: string, idOrSlug: string) => request(ctx.app).put(`/v1/me/wishlist/${idOrSlug}`).set(bearer(token));
const remove = (token: string, idOrSlug: string) => request(ctx.app).delete(`/v1/me/wishlist/${idOrSlug}`).set(bearer(token));
const get = async (token: string) => (await request(ctx.app).get('/v1/me/wishlist').set(bearer(token))).body.products as { slug: string; availability: string }[];

describe('wishlist', () => {
  it('adds by id or slug, newest first', async () => {
    expect((await add(alice, jerseyId)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 5));
    expect((await add(alice, BOOT)).status).toBe(204);
    expect((await get(alice)).map((p) => p.slug)).toEqual([BOOT, JERSEY]);
  });

  it('is idempotent', async () => {
    await add(alice, JERSEY);
    await add(alice, JERSEY);
    expect(await get(alice)).toHaveLength(1);
  });

  it('removes items, also idempotently', async () => {
    await add(alice, JERSEY);
    expect((await remove(alice, JERSEY)).status).toBe(204);
    expect((await remove(alice, JERSEY)).status).toBe(204);
    expect(await get(alice)).toEqual([]);
  });

  it('answers 404 for products that do not exist or are not on sale', async () => {
    expect((await add(alice, 'no-such-product')).status).toBe(404);
    expect((await add(alice, '00000000-0000-0000-0000-000000000000')).status).toBe(404);
    await database.pool.query("update products set status = 'draft' where slug = $1", [BOOT]);
    expect((await add(alice, BOOT)).status).toBe(404);
  });

  it('hides products that were archived after being saved', async () => {
    await add(alice, JERSEY);
    await database.pool.query("update products set status = 'archived' where slug = $1", [JERSEY]);
    const res = await request(ctx.app).get('/v1/me/wishlist').set(bearer(alice));
    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it('keeps sold-out products, marked out', async () => {
    await add(alice, JERSEY);
    await setProductStock(database, JERSEY, 0);
    expect(await get(alice)).toMatchObject([{ slug: JERSEY, availability: 'out' }]);
  });

  it('keeps each member’s list separate and requires sign-in', async () => {
    await add(alice, JERSEY);
    expect(await get(bob)).toEqual([]);
    expect((await request(ctx.app).get('/v1/me/wishlist')).status).toBe(401);
  });
});
