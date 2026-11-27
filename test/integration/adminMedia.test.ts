import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';
import { testConfig } from '../helpers/testConfig.js';

// The smallest valid PNG: 1×1 transparent pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
let customer: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const upload = (token: string, body: Buffer, type: string) => request(ctx.app).post('/v1/admin/media').set(bearer(token)).set('content-type', type).send(body);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  ctx = memberApp(database);
  admin = ctx.fake.token({ uid: 'media-admin', phone: '+85511110010' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(admin));
  await q("update users set role = 'admin' where firebase_uid = 'media-admin'");
  customer = ctx.fake.token({ uid: 'media-customer', phone: '+85511110011' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(customer));
});
afterAll(closeTestDb);

describe('product photo uploads', () => {
  it('stores an uploaded photo and serves it back, byte for byte, cacheable from another origin', async () => {
    const res = await upload(admin, PNG, 'image/png').expect(201);
    expect(res.body.path).toMatch(/^media\/[0-9a-f-]{36}\.png$/);
    expect(res.body.url).toBe(`${testConfig().publicApiUrl}/v1/${res.body.path}`);
    const got = await request(ctx.app).get(`/v1/${res.body.path}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(got.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);
  });

  it('refuses files that are not photos, or that lie about their type', async () => {
    await upload(admin, Buffer.from('hello'), 'text/plain').expect(415);
    await upload(admin, Buffer.from('not really a png'), 'image/png').expect(400);
  });

  it('refuses photos over 4 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    const res = await upload(admin, big, 'image/png');
    expect(res.status).toBe(413);
  });

  it('only lets admins upload', async () => {
    await upload(customer, PNG, 'image/png').expect(403);
  });

  it('answers 404 for a photo that does not exist or a malformed name', async () => {
    await request(ctx.app).get('/v1/media/00000000-0000-4000-8000-000000000000.png').expect(404);
    await request(ctx.app).get('/v1/media/..%2Fetc.png').expect(404);
  });

  it('shows an uploaded photo on the shop card once it is set as the product photo', async () => {
    const { body } = await upload(admin, PNG, 'image/png').expect(201);
    const product = (await q("select id, slug from products where status = 'active' order by slug limit 1")).rows[0];
    await request(ctx.app).put(`/v1/admin/products/${product.id}/images`).set(bearer(admin)).send({ images: [{ path: body.path }] }).expect(200);
    const detail = await request(ctx.app).get(`/v1/catalog/products/${product.slug}`).expect(200);
    expect(detail.body.product.imageUrl).toBe(body.url);
  });
});
