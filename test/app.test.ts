import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { silentLogger, testConfig } from './setup/silent.js';

const app = createApp({ config: testConfig, logger: silentLogger });

describe('app basics', () => {
  it('GET /health → 200 with a generated X-Request-Id', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a valid incoming X-Request-Id', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'abc12345-req');
    expect(res.headers['x-request-id']).toBe('abc12345-req');
  });

  it('replaces an invalid incoming X-Request-Id', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'bad id!');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown route → 404 problem+json', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, title: 'Not Found', instance: '/nope' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });

  it('malformed JSON → 400 problem', async () => {
    const res = await request(app).post('/health').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/\/problems\/malformed-json$/);
  });

  it('body over 100 kB → 413 problem', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(101 * 1024) });
    const res = await request(app).post('/health').set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.type).toMatch(/\/problems\/payload-too-large$/);
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
