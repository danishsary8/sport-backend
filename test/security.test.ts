import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './setup/test-app.js';
import { testConfig } from './setup/silent.js';

const limited = buildTestApp({ config: { ...testConfig, rateLimitPerMinute: 3 } });
const open = buildTestApp();
afterAll(() => Promise.all([limited.pool.end(), open.pool.end()]));

describe('rate limiting', () => {
  it('returns a 429 problem after the limit', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await request(limited.app).get('/v1/products?league=none')).status).toBe(200);
    }
    const res = await request(limited.app).get('/v1/products?league=none');
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/rate-limited$/);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('does not rate limit health checks', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request(limited.app).get('/health')).status).toBe(200);
    }
  });
});

describe('CORS', () => {
  it('allows a configured origin with credentials', async () => {
    const res = await request(open.app).get('/v1/products?league=none').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('answers preflight requests for a configured origin', async () => {
    const res = await request(open.app)
      .options('/v1/products')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
  });

  it('sends no CORS headers to an unknown origin', async () => {
    const res = await request(open.app).get('/v1/products?league=none').set('Origin', 'http://evil.test');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
