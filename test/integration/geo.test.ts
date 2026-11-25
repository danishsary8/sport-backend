import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { memberApp } from '../helpers/app.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);

describe('geo endpoints', () => {
  it('lists all provinces with long-lived caching', async () => {
    const res = await request(memberApp(database).app).get('/v1/geo/provinces');
    expect(res.status).toBe(200);
    expect(res.body.provinces).toHaveLength(25);
    expect(res.body.provinces).toContainEqual({ code: '12', nameEn: 'Phnom Penh', nameKm: 'ភ្នំពេញ' });
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
  });

  it('lists the districts of a province', async () => {
    const res = await request(memberApp(database).app).get('/v1/geo/districts?provinceCode=12');
    expect(res.status).toBe(200);
    const names = res.body.districts.map((d: { nameEn: string }) => d.nameEn);
    expect(names).toContain('Chamkar Mon');
  });

  it('lists the communes of a district, all within it', async () => {
    const districts = await request(memberApp(database).app).get('/v1/geo/districts?provinceCode=12');
    const code = districts.body.districts[0].code as string;
    const res = await request(memberApp(database).app).get(`/v1/geo/communes?districtCode=${code}`);
    expect(res.body.communes.length).toBeGreaterThan(0);
    for (const c of res.body.communes) expect(c.code.startsWith(code)).toBe(true);
  });

  it('requires the parent code', async () => {
    expect((await request(memberApp(database).app).get('/v1/geo/districts')).status).toBe(400);
    expect((await request(memberApp(database).app).get('/v1/geo/communes')).status).toBe(400);
  });

  it('returns an empty list for an unknown parent', async () => {
    const res = await request(memberApp(database).app).get('/v1/geo/districts?provinceCode=99');
    expect(res.body.districts).toEqual([]);
  });
});

describe('GET /v1/branches', () => {
  it('lists the three stores in order', async () => {
    const res = await request(memberApp(database).app).get('/v1/branches');
    expect(res.status).toBe(200);
    expect(res.body.branches.map((b: { id: string }) => b.id)).toEqual(['sonthormuk', 'sensok', 'chomkadong']);
    expect(res.body.branches[0]).toMatchObject({ phone: '+85512889261', pickupEnabled: true });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });
});
