import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app.js';
import { createLogger } from '../../src/lib/logger.js';
import { testConfig } from '../helpers/testConfig.js';

function buildApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    config: testConfig(),
    logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    db: { ping: async () => {} },
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
