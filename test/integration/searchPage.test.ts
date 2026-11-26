import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { memberApp } from '../helpers/app.js';
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

describe('GET /v1/search', () => {
  it('returns listing-shaped results for a query, filterable like the listing', async () => {
    const all = await request(ctx.app).get('/v1/search?q=nike').expect(200);
    expect(all.body.total).toBeGreaterThan(0);
    expect(all.body.products[0]).toHaveProperty('slug');
    expect(all.headers['cache-control']).toContain('public');
    const boots = await request(ctx.app).get('/v1/search?q=nike&category=boots').expect(200);
    expect(boots.body.total).toBeLessThanOrEqual(all.body.total);
    expect(boots.body.products.every((p: { category: string }) => p.category === 'boots')).toBe(true);
  });

  it('needs at least 2 characters', async () => {
    await request(ctx.app).get('/v1/search?q=n').expect(400);
    await request(ctx.app).get('/v1/search').expect(400);
  });
});
