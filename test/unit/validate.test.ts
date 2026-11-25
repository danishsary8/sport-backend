import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../../src/lib/errors.js';
import { createLogger } from '../../src/lib/logger.js';
import { validate } from '../../src/middleware/validate.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/items', validate({ body: z.object({ qty: z.number().int().min(1) }) }), (req, res) => {
    res.json(req.body);
  });
  app.get('/list', validate({ query: z.object({ page: z.coerce.number().int().min(1) }) }), (req, res) => {
    res.json({ page: req.query.page, type: typeof req.query.page });
  });
  app.use(errorHandler(createLogger({ logLevel: 'fatal', nodeEnv: 'test' })));
  return app;
}

describe('validate', () => {
  it('rejects an invalid body with field details', async () => {
    const res = await request(buildApp()).post('/items').send({ qty: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details[0].path).toBe('qty');
  });

  it('strips unknown keys from the body', async () => {
    const res = await request(buildApp()).post('/items').send({ qty: 2, unitPrice: 0.01 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ qty: 2 });
  });

  it('coerces query values', async () => {
    const res = await request(buildApp()).get('/list?page=3');
    expect(res.body).toEqual({ page: 3, type: 'number' });
  });
});
