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

describe('API security headers', () => {
  it('locks down a JSON API response', async () => {
    const { app } = memberApp(database);
    const res = await request(app).get('/v1/branches').expect(200);
    expect(res.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('gives the dev payment page just enough to show a form', async () => {
    const { app } = memberApp(database);
    const res = await request(app).get('/v1/dev/payments/SC2611AAAAA-1/checkout').expect(200);
    expect(res.headers['content-security-policy']).toContain("form-action 'self'");
  });

  it('lets browsers revalidate catalog reads with ETags', async () => {
    const { app } = memberApp(database);
    const first = await request(app).get('/v1/branches').expect(200);
    expect(first.headers.etag).toBeTruthy();
    await request(app).get('/v1/branches').set('If-None-Match', String(first.headers.etag)).expect(304);
  });

  it('sends credentials headers only to allowed origins', async () => {
    const { app } = memberApp(database);
    const allowed = await request(app).get('/v1/branches').set('Origin', 'https://shop.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://shop.example');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const other = await request(app).get('/v1/branches').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    expect(other.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
