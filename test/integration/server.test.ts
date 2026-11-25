import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/env.js';
import { start } from '../../src/server.js';
import { TEST_DATABASE_URL } from '../helpers/testConfig.js';

const env = {
  NODE_ENV: 'test',
  PORT: '0',
  DATABASE_URL: TEST_DATABASE_URL,
  COOKIE_SECRET: 'test-cookie-secret-test-cookie-secret',
  LOG_LEVEL: 'fatal',
};

describe('start', () => {
  it('serves requests and stops cleanly', async () => {
    const server = await start(env);
    const health = await fetch(`${server.url}/health`);
    expect(health.status).toBe(200);
    const ready = await fetch(`${server.url}/ready`);
    expect(await ready.json()).toEqual({ status: 'ready' });

    await server.stop();
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });

  it('refuses to start without a valid configuration', async () => {
    await expect(start({})).rejects.toBeInstanceOf(ConfigError);
  });
});
