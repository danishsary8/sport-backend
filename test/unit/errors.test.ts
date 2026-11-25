import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppError, errorHandler, notFoundHandler } from '../../src/lib/errors.js';
import { createLogger, redactPhone } from '../../src/lib/logger.js';
import { requestId } from '../../src/middleware/requestId.js';

function buildApp() {
  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: '1mb' }));
  app.get('/conflict', () => {
    throw new AppError('out_of_stock', 409, 'Only 1 left');
  });
  app.get('/boom', () => {
    throw new Error('boom secret detail');
  });
  app.get('/async-boom', async (_req, _res, next) => {
    try {
      await Promise.reject(new Error('async failure'));
    } catch (err) {
      next(err);
    }
  });
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.use(notFoundHandler);
  app.use(errorHandler(createLogger({ logLevel: 'fatal', nodeEnv: 'test' })));
  return app;
}

describe('error handling', () => {
  it('renders AppError with its status and code', async () => {
    const res = await request(buildApp()).get('/conflict');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'out_of_stock', message: 'Only 1 left' } });
  });

  it('hides unexpected errors behind internal_error with the request id', async () => {
    const res = await request(buildApp()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'internal_error',
        message: 'Internal server error',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });

  it('rejects malformed JSON with invalid_json', async () => {
    const res = await request(buildApp())
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('rejects bodies over 1 MB with payload_too_large', async () => {
    const big = JSON.stringify({ data: 'x'.repeat(1.1 * 1024 * 1024) });
    const res = await request(buildApp())
      .post('/echo')
      .set('content-type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('returns not_found for unknown paths', async () => {
    const res = await request(buildApp()).get('/v1/missing');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('request id', () => {
  it('sets an id on every response', async () => {
    const res = await request(buildApp()).get('/v1/missing');
    expect(res.headers['x-request-id']).toMatch(/^[\w-]{8,64}$/);
  });

  it('echoes a well-formed inbound id', async () => {
    const res = await request(buildApp()).get('/v1/missing').set('X-Request-Id', 'abcdefgh-1234');
    expect(res.headers['x-request-id']).toBe('abcdefgh-1234');
  });

  it('replaces a malformed inbound id', async () => {
    const res = await request(buildApp()).get('/v1/missing').set('X-Request-Id', 'bad id <script>');
    expect(res.headers['x-request-id']).not.toBe('bad id <script>');
  });
});

describe('redactPhone', () => {
  it('keeps only the last three digits', () => {
    expect(redactPhone('+85512345678')).toBe('***678');
  });
});

describe('async route errors', () => {
  it('turns a rejected async handler into a 500 response instead of crashing', async () => {
    const app = express();
    app.use(requestId);
    app.get('/async-throw', async () => {
      await Promise.resolve();
      throw new Error('async kaboom');
    });
    app.use(errorHandler(createLogger({ logLevel: 'fatal', nodeEnv: 'test' })));
    const res = await request(app).get('/async-throw').timeout(2000);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal_error');
  });
});
