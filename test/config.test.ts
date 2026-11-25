import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('rejects a missing DATABASE_URL with a readable message', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
  });

  it('requires PUBLIC_BASE_URL in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x' })).toThrow(
      /PUBLIC_BASE_URL/,
    );
  });

  it('parses CORS_ORIGINS as a list', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      CORS_ORIGINS: 'http://a.test, http://b.test',
    });
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('applies defaults', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(config).toMatchObject({ port: 8080, logLevel: 'info', rateLimitPerMinute: 300, nodeEnv: 'development' });
  });
});
