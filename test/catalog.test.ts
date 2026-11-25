import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { loadCatalogFile, seedCatalog } from '../src/db/seed.js';
import { buildTestApp, resetDb } from './setup/test-app.js';

const { app, db, pool } = buildTestApp();

beforeAll(async () => {
  await resetDb(db);
  await seedCatalog(db, loadCatalogFile());
});
afterAll(() => pool.end());

interface Item {
  slug: string;
  league: string | null;
  kitType: string | null;
  priceCents: number;
  name: string;
  team: string | null;
}

describe('GET /v1/products', () => {
  it('lists 24 products by default with a nextCursor', async () => {
    const res = await request(app).get('/v1/products');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(24);
    expect(typeof res.body.nextCursor).toBe('string');
    expect(res.body.items[0]).toMatchObject({ slug: expect.any(String), priceCents: expect.any(Number) });
  });

  it('walks all pages with cursors without repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(app).get('/v1/products').query({ limit: 17, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: Item) => i.slug));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(80);
    expect(new Set(seen).size).toBe(80);
  });

  it.each(['price-asc', 'price-desc', 'newest', 'rating'])('pages through sort=%s without repeats', async (sort) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await request(app).get('/v1/products').query({ sort, limit: 13, ...(cursor ? { cursor } : {}) });
      seen.push(...res.body.items.map((i: Item) => i.slug));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(80);
  });

  it('filters league=premier-league,la-liga&kit=home (OR within, AND across)', async () => {
    const res = await request(app).get('/v1/products?league=premier-league,la-liga&kit=home&limit=60');
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items as Item[]) {
      expect(['Premier League', 'La Liga']).toContain(item.league);
      expect(item.kitType).toBe('home');
    }
  });

  it('sorts price-asc', async () => {
    const res = await request(app).get('/v1/products?sort=price-asc&limit=60');
    const prices = (res.body.items as Item[]).map((i) => i.priceCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('q=madrid finds Real Madrid kits', async () => {
    const res = await request(app).get('/v1/products?q=MADRID&limit=60');
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const item of res.body.items as Item[]) {
      expect(`${item.name} ${item.team}`.toLowerCase()).toContain('madrid');
    }
  });

  it('unknown filter value → 200 empty list', async () => {
    const res = await request(app).get('/v1/products?league=atlantis');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it.each(['limit=0', 'limit=1000', 'cursor=%25%25%25', 'sort=cheapest', 'category=hats', 'q='])(
    '%s → 400 problem with errors[]',
    async (qs) => {
      const res = await request(app).get(`/v1/products?${qs}`);
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(Array.isArray(res.body.errors) || typeof res.body.detail === 'string').toBe(true);
    },
  );

  it('rejects too many values in one filter', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`).join(',');
    const res = await request(app).get(`/v1/products?team=${many}`);
    expect(res.status).toBe(400);
  });
});

describe('cursor misuse', () => {
  it('a cursor from one sort used with another sort → 400, not 500', async () => {
    const first = await request(app).get('/v1/products?sort=price-asc&limit=2');
    const res = await request(app).get(`/v1/products?sort=newest&cursor=${first.body.nextCursor}`);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('a well-formed cursor with the wrong value type → 400, not 500', async () => {
    const forged = Buffer.from(JSON.stringify(['not-a-number', 'some-slug'])).toString('base64url');
    const res = await request(app).get(`/v1/products?sort=price-asc&cursor=${forged}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/products/:slug', () => {
  it('returns detail with sizes and priceCents', async () => {
    const res = await request(app).get('/v1/products/real-madrid-2026-27-home-authentic-jersey');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: 'real-madrid-2026-27-home-authentic-jersey',
      priceCents: 9800,
      category: 'jerseys',
      kitType: 'home',
      media: { front: expect.any(String) },
    });
    expect(res.body.sizes.length).toBeGreaterThan(0);
    expect(res.body.sizes[0]).toEqual({ size: expect.any(String), quantity: expect.any(Number), inStock: expect.any(Boolean) });
  });

  it.each(['x'.repeat(300), '..%2Fetc', 'REAL-MADRID-2026-27-HOME-AUTHENTIC-JERSEY', 'nope'])('slug %s → 404 problem', async (slug) => {
    const res = await request(app).get(`/v1/products/${slug}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });
});

describe('database unavailable', () => {
  it('catalog → 503 problem, not a crash', async () => {
    const down = createDb('postgres://postgres:postgres@127.0.0.1:1/nope');
    const broken = buildTestApp({ db: down.db });
    const res = await request(broken.app).get('/v1/products');
    await Promise.all([down.pool.end(), broken.pool.end()]);
    expect(res.status).toBe(503);
    expect(res.body.type).toMatch(/service-unavailable$/);
  });
});
