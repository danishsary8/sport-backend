import net from 'node:net';
import { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { sslOptions } from '../../src/db/client.js';
import { errorHandler } from '../../src/lib/errors.js';
import { createLogger } from '../../src/lib/logger.js';
import { httpLogger } from '../../src/middleware/httpLog.js';
import { start } from '../../src/server.js';
import { TEST_DATABASE_URL } from '../helpers/testConfig.js';

function sink() {
  const lines: { level: number; msg: string; req?: { url: string } }[] = [];
  const stream = new Writable({
    write(chunk, _e, done) {
      for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      done();
    },
  });
  return { lines, stream };
}

function appWithLogs() {
  const { lines, stream } = sink();
  const logger = createLogger({ logLevel: 'info', nodeEnv: 'test' }, stream);
  const app = express();
  app.use(httpLogger(logger));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/ready', (_req, res) => res.json({ status: 'ready' }));
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  app.use(errorHandler(logger));
  return { app, lines };
}

describe('access logging', () => {
  it('logs a server error at error level exactly once', async () => {
    const { app, lines } = appWithLogs();
    await request(app).get('/boom').expect(500);
    expect(lines.filter((l) => l.level >= 50)).toHaveLength(1);
  });

  it('does not log health probes', async () => {
    const { app, lines } = appWithLogs();
    await request(app).get('/health').expect(200);
    await request(app).get('/ready').expect(200);
    expect(lines).toHaveLength(0);
  });
});

describe('body errors', () => {
  it.each([
    ['request.aborted', 400, 'request_aborted'],
    ['request.size.invalid', 400, 'invalid_body'],
    ['entity.verify.failed', 400, 'invalid_body'],
    ['parameters.too.many', 413, 'payload_too_large'],
  ])('maps %s to %i', async (type, status, code) => {
    const app = express();
    app.get('/x', () => {
      throw Object.assign(new Error('body'), { type });
    });
    app.use(errorHandler(createLogger({ logLevel: 'fatal', nodeEnv: 'test' })));
    const res = await request(app).get('/x').expect(status);
    expect(res.body.error.code).toBe(code);
  });
});

describe('database TLS', () => {
  const base = { DATABASE_URL: 'postgres://x', COOKIE_SECRET: 'a'.repeat(32) };
  it('accepts a CA certificate and pins it', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    const cfg = loadConfig({ ...base, DATABASE_SSL: 'true', DATABASE_SSL_CA: pem });
    expect(sslOptions(cfg)).toEqual({ rejectUnauthorized: true, ca: pem });
    expect(sslOptions(loadConfig({ ...base, DATABASE_SSL: 'true' }))).toEqual({ rejectUnauthorized: true });
    expect(sslOptions(loadConfig(base))).toBeUndefined();
  });
});

describe('startup', () => {
  it('closes the database pool when the port is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '0.0.0.0', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    let pool: { ended: boolean } | undefined;
    try {
      await expect(
        start(
          { NODE_ENV: 'test', PORT: String(port), DATABASE_URL: TEST_DATABASE_URL, COOKIE_SECRET: 'x'.repeat(40), LOG_LEVEL: 'fatal', JOBS_ENABLED: 'false' },
          { onDatabase: (d) => (pool = d.pool) },
        ),
      ).rejects.toThrow();
      expect(pool?.ended).toBe(true);
    } finally {
      blocker.close();
    }
  });
});
