import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let alice: string;
let bob: string;

/** Phnom Penh → Chamkar Mon → one of its communes, plus a commune from another district. */
const geo = { province: '12', district: '', commune: '', otherCommune: '', otherProvinceDistrict: '' };

beforeAll(async () => {
  database = await testDb();
  const d = await database.pool.query("select code from geo_districts where province_code = '12' and name_en = 'Chamkar Mon'");
  geo.district = d.rows[0].code;
  const c = await database.pool.query('select code from geo_communes where district_code = $1 order by code limit 1', [geo.district]);
  geo.commune = c.rows[0].code;
  const oc = await database.pool.query(
    "select c.code from geo_communes c join geo_districts d on d.code = c.district_code where d.province_code = '12' and d.code <> $1 limit 1",
    [geo.district],
  );
  geo.otherCommune = oc.rows[0].code;
  const od = await database.pool.query("select code from geo_districts where province_code <> '12' limit 1");
  geo.otherProvinceDistrict = od.rows[0].code;
});
afterAll(closeTestDb);

beforeEach(async () => {
  await resetDb(database);
  ctx = memberApp(database);
  alice = ctx.fake.token({ uid: 'alice', phone: '+85512345678' });
  bob = ctx.fake.token({ uid: 'bob', phone: '+85596889217' });
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    label: 'Home',
    recipientName: 'Alice',
    phone: '012 345 678',
    provinceCode: geo.province,
    districtCode: geo.district,
    communeCode: geo.commune,
    street: 'No. 12, Street 310',
    ...overrides,
  };
}

const create = (token: string, overrides: Record<string, unknown> = {}) =>
  request(ctx.app).post('/v1/me/addresses').set(bearer(token)).send(body(overrides));
const list = async (token: string) => (await request(ctx.app).get('/v1/me/addresses').set(bearer(token))).body.addresses;

describe('creating addresses', () => {
  it('stores a normalised phone and resolves geo names; the first address is the default', async () => {
    const res = await create(alice);
    expect(res.status).toBe(201);
    expect(res.body.address).toMatchObject({
      label: 'Home',
      phone: '+85512345678',
      isDefault: true,
      province: { code: '12', nameEn: 'Phnom Penh', nameKm: 'ភ្នំពេញ' },
      district: { code: geo.district, nameEn: 'Chamkar Mon' },
      commune: { code: geo.commune },
    });
  });

  it('rejects an invalid phone', async () => {
    const res = await create(alice, { phone: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('phone');
  });

  it('rejects a commune outside the chosen district', async () => {
    const res = await create(alice, { communeCode: geo.otherCommune });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('communeCode');
  });

  it('rejects a district outside the chosen province', async () => {
    const res = await create(alice, { districtCode: geo.otherProvinceDistrict });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('districtCode');
  });

  it('rejects unknown codes', async () => {
    const res = await create(alice, { communeCode: '99999999' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('communeCode');
  });

  it('requires lat and lng together, inside Cambodia', async () => {
    expect((await create(alice, { lat: 11.55 })).status).toBe(400);
    expect((await create(alice, { lat: 48.85, lng: 2.35 })).status).toBe(400);
    expect((await create(alice, { lat: 11.55, lng: 104.92 })).status).toBe(201);
  });

  it('caps a member at 20 addresses', async () => {
    for (let i = 0; i < 20; i += 1) expect((await create(alice, { label: `A${i}` })).status).toBe(201);
    const res = await create(alice, { label: 'one too many' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('address_limit');
  });
});

describe('defaults', () => {
  it('moves the default when a new default is created, keeping exactly one', async () => {
    const first = (await create(alice)).body.address;
    const second = (await create(alice, { label: 'Work', isDefault: true })).body.address;
    const all = await list(alice);
    expect(all.filter((a: { isDefault: boolean }) => a.isDefault).map((a: { id: string }) => a.id)).toEqual([second.id]);
    expect(all[0].id).toBe(second.id);
    expect(all.find((a: { id: string }) => a.id === first.id).isDefault).toBe(false);
  });

  it('sets a default through the dedicated endpoint', async () => {
    await create(alice);
    const work = (await create(alice, { label: 'Work' })).body.address;
    const res = await request(ctx.app).post(`/v1/me/addresses/${work.id}/default`).set(bearer(alice));
    expect(res.status).toBe(200);
    expect(res.body.address.isDefault).toBe(true);
    expect((await list(alice)).filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
  });

  it('promotes the newest remaining address when the default is deleted', async () => {
    const home = (await create(alice)).body.address;
    await create(alice, { label: 'Older' });
    const newest = (await create(alice, { label: 'Newest' })).body.address;
    expect((await request(ctx.app).delete(`/v1/me/addresses/${home.id}`).set(bearer(alice))).status).toBe(204);
    const all = await list(alice);
    expect(all).toHaveLength(2);
    expect(all.find((a: { isDefault: boolean }) => a.isDefault).id).toBe(newest.id);
  });
});

describe('editing', () => {
  it('updates fields and re-validates the geo hierarchy', async () => {
    const home = (await create(alice)).body.address;
    const ok = await request(ctx.app).patch(`/v1/me/addresses/${home.id}`).set(bearer(alice)).send({ street: 'New street', landmark: 'Near the market' });
    expect(ok.status).toBe(200);
    expect(ok.body.address).toMatchObject({ street: 'New street', landmark: 'Near the market' });

    const bad = await request(ctx.app).patch(`/v1/me/addresses/${home.id}`).set(bearer(alice)).send({ communeCode: geo.otherCommune });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0].path).toBe('communeCode');
  });
});

describe('ownership', () => {
  it("hides other members' addresses behind 404", async () => {
    const home = (await create(alice)).body.address;
    await request(ctx.app).post('/v1/auth/session').set(bearer(bob));
    for (const call of [
      request(ctx.app).patch(`/v1/me/addresses/${home.id}`).set(bearer(bob)).send({ street: 'hijack' }),
      request(ctx.app).delete(`/v1/me/addresses/${home.id}`).set(bearer(bob)),
      request(ctx.app).post(`/v1/me/addresses/${home.id}/default`).set(bearer(bob)),
    ]) {
      const res = await call;
      expect(res.status).toBe(404);
    }
    expect((await list(alice))[0].street).toBe('No. 12, Street 310');
    expect(await list(bob)).toEqual([]);
  });

  it('answers 404 for an id that is not a uuid', async () => {
    const res = await request(ctx.app).delete('/v1/me/addresses/not-a-uuid').set(bearer(alice));
    expect(res.status).toBe(404);
  });
});
