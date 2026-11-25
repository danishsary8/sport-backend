import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import { createLogger } from '../../src/lib/logger.js';
import type { Database } from '../../src/db/client.js';
import { closeTestDb, testDb } from '../helpers/db.js';
import { fakeIdentity } from '../helpers/fakeIdentity.js';
import { testConfig } from '../helpers/testConfig.js';

let database: Database;
beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);

/** The real test database with ping replaced, to simulate outages. */
const withPing = (ping: () => Promise<void>): Database => ({ ...database, ping });

function buildApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    config: testConfig(),
    logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    db: database,
    identity: fakeIdentity().provider,
    ...overrides,
  });
}

describe('createApp', () => {
  it('returns not_found JSON for unknown API routes', async () => {
    const res = await request(buildApp()).get('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(buildApp()).get('/v1/nope');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows a listed origin with credentials', async () => {
    const res = await request(buildApp()).get('/v1/nope').set('Origin', 'https://shop.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://shop.example');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow an unlisted origin', async () => {
    const res = await request(buildApp()).get('/v1/nope').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate limits the API', async () => {
    const app = buildApp({ rateLimit: { enabled: true, generalMax: 3 } });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/v1/nope')).status).toBe(404);
    }
    const limited = await request(app).get('/v1/nope');
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
  });
});

describe('health probes', () => {
  it('reports liveness without details', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports ready when the database answers', async () => {
    const res = await request(buildApp()).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports unavailable when the database fails', async () => {
    const res = await request(buildApp({ db: withPing(async () => Promise.reject(new Error('down'))) })).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'unavailable' });
  });

  it('gives up on a hung database within the 3s timeout', async () => {
    const started = Date.now();
    const res = await request(buildApp({ db: withPing(() => new Promise<void>(() => {})) })).get('/ready');
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(3500);
  }, 6000);

  it('does not rate limit the probes', async () => {
    const app = buildApp({ rateLimit: { enabled: true, generalMax: 1 } });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/health')).status).toBe(200);
    }
  });
});
