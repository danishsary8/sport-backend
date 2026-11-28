import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { createSmartSearch, type ModelAnswer } from '../../src/modules/search/smartSearch.js';
import { memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
const prompts: string[] = [];
const answer: ModelAnswer = { category: 'jerseys', brand: ['adidas'], league: ['International'], continent: ['south-america'], season: [], kitType: [], surface: [], priceMin: null, priceMax: 100, keywords: 'messi' };

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
});
afterAll(closeTestDb);

describe('GET /v1/search/smart', () => {
  it('turns words into filters the catalogue really has, using the live vocabulary', async () => {
    const { app } = memberApp(database, undefined, {
      smartSearch: createSmartSearch(async (system) => {
        prompts.push(system);
        return answer;
      }),
    });
    const res = await request(app).get('/v1/search/smart').query({ q: 'argentina messi shirt under 100', lang: 'en' }).expect(200);
    expect(res.body).toEqual({
      available: true,
      filters: { category: 'jerseys', brand: ['adidas'], league: ['International'], continent: ['south-america'], priceMaxCents: 10000, q: 'messi' },
    });
    expect(prompts[0]).toContain('2026/27');
    expect(prompts[0]).toContain('jerseys = Jerseys & Kits');
    // The filters work on the real listing.
    const list = await request(app).get('/v1/catalog/products').query({ category: 'jerseys', brand: 'adidas', continent: 'south-america', priceMax: 10000 }).expect(200);
    expect(list.body.total).toBeGreaterThan(0);
  });

  it('says smart search is off when no API key is set, so the shop uses plain search', async () => {
    const { app } = memberApp(database);
    expect((await request(app).get('/v1/search/smart').query({ q: 'red boots' }).expect(200)).body).toEqual({ available: false, filters: null });
  });

  it('needs a query', async () => {
    const { app } = memberApp(database);
    await request(app).get('/v1/search/smart').expect(400);
  });
});
