import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';
import { testConfig } from '../helpers/testConfig.js';
import { AppError } from '../../src/lib/errors.js';
import type { ImageFetcher } from '../../src/modules/admin/remoteImage.js';

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

/** An app whose photo downloader is fake: returns the bytes for a link (or throws like the real one). */
function memberAppWith(download: (url: string) => Promise<Buffer>): () => ReturnType<typeof memberApp> {
  let app: ReturnType<typeof memberApp> | undefined;
  const fetchImage: ImageFetcher = download;
  return () => (app ??= memberApp(database, ctx.fake, { imageFetcher: fetchImage }));
}

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

describe('photos from links', () => {
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]);
  const seen: string[] = [];
  const fetched = memberAppWith(async (url: string) => {
    seen.push(url);
    if (url.endsWith('/front.webp')) return WEBP;
    if (url.endsWith('/page.html')) return Buffer.from('<html>');
    throw new AppError('validation_failed', 400, 'Could not download that photo (HTTP 404)');
  });
  const fromUrl = (token: string, url: unknown) => request(fetched().app).post('/v1/admin/media/from-url').set(bearer(token)).send({ url });

  it('downloads a photo and stores it like an upload, typed by its contents', async () => {
    const res = await fromUrl(admin, 'https://cdn.example.com/front.webp').expect(201);
    expect(res.body.path).toMatch(/^media\/[0-9a-f-]{36}\.webp$/);
    expect(seen).toContain('https://cdn.example.com/front.webp');
    const row = (await q('select content_type, size from media_files where id = $1', [res.body.path.slice(6, 42)])).rows[0];
    expect(row).toEqual({ content_type: 'image/webp', size: WEBP.length });
  });

  it('refuses a link that is not a photo, and passes on download problems', async () => {
    expect((await fromUrl(admin, 'https://cdn.example.com/page.html').expect(400)).body.error.message).toBe('That link is not a JPG, PNG or WebP photo');
    expect((await fromUrl(admin, 'https://cdn.example.com/missing.webp').expect(400)).body.error.message).toBe('Could not download that photo (HTTP 404)');
    await fromUrl(admin, 42).expect(400);
  });

  it('is for admins only', async () => {
    await fromUrl(customer, 'https://cdn.example.com/front.webp').expect(403);
  });
});
