import { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { pinoHttp } from 'pino-http';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../../src/lib/errors.js';
import { createLogger, REDACT_PATHS } from '../../src/lib/logger.js';

function sink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, stream };
}

describe('log redaction', () => {
  it('never logs order access tokens from request headers', async () => {
    expect(REDACT_PATHS).toContain('req.headers["x-order-token"]');
    const { lines, stream } = sink();
    const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, stream);
    const app = express();
    app.use(pinoHttp({ logger }));
    app.get('/x', (_req, res) => res.json({ ok: true }));
    await request(app).get('/x').set('x-order-token', 'SECRET-ORDER-TOKEN').expect(200);
    expect(lines.join('\n')).not.toContain('SECRET-ORDER-TOKEN');
  });

  it('logs database errors without query parameters or row details', async () => {
    const { lines, stream } = sink();
    const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, stream);
    const app = express();
    app.get('/boom', () => {
      throw Object.assign(new Error('Failed query: insert into orders ... params: Sok Dara,+85512345678,dara@example.com'), {
        query: 'insert into orders ...',
        params: ['Sok Dara', '+85512345678', 'dara@example.com'],
        cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', detail: 'Key (contact_phone_e164)=(+85512345678) already exists.' }),
      });
    });
    app.use(errorHandler(logger));
    await request(app).get('/boom').expect(500);
    const text = lines.join('\n');
    expect(text).toContain('23505');
    expect(text).toContain('duplicate key value');
    expect(text).not.toContain('12345678');
    expect(text).not.toContain('dara@example.com');
    expect(text).not.toContain('Sok Dara');
  });
});
