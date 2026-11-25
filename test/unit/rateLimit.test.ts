import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/lib/errors.js';
import { createLogger } from '../../src/lib/logger.js';
import { createRateLimitMiddleware, InMemoryRateLimitStore } from '../../src/middleware/rateLimit.js';

const t0 = 1_700_000_000_000;

describe('InMemoryRateLimitStore', () => {
  it('allows up to the limit within a fixed window, then blocks with retry-after', () => {
    const store = new InMemoryRateLimitStore(100);
    expect(store.consume('b:1.2.3.4', 60_000, 2, t0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(store.consume('b:1.2.3.4', 60_000, 2, t0 + 5_000)).toMatchObject({ allowed: true, remaining: 0 });
    expect(store.consume('b:1.2.3.4', 60_000, 2, t0 + 10_000)).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 50,
    });
  });

  it('resets after the window expires', () => {
    const store = new InMemoryRateLimitStore(100);
    store.consume('b:ip', 60_000, 1, t0);
    expect(store.consume('b:ip', 60_000, 1, t0 + 60_001)).toMatchObject({ allowed: true, remaining: 0 });
  });

  it('stays bounded under many distinct keys', () => {
    const store = new InMemoryRateLimitStore(100);
    for (let i = 0; i < 125; i += 1) store.consume(`flood:10.0.0.${i}`, 60_000, 5, t0);
    expect(store.size()).toBeLessThanOrEqual(100);
  });
});

describe('createRateLimitMiddleware', () => {
  it('answers 429 in the standard error shape with Retry-After', async () => {
    const app = express();
    app.use(createRateLimitMiddleware({ bucket: 't', windowMs: 60_000, maxRequests: 1, nowMs: () => t0 }));
    app.get('/x', (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler(createLogger({ logLevel: 'fatal', nodeEnv: 'test' })));

    const first = await request(app).get('/x');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('1');

    const second = await request(app).get('/x');
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('60');
    expect(second.body).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many requests. Please slow down and try again shortly.',
        details: { retryAfterSeconds: 60 },
      },
    });
  });
});
