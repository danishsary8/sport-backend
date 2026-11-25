import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';

const base = { DATABASE_URL: 'postgres://x', COOKIE_SECRET: 'a'.repeat(32) };

function issuesFor(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('applies defaults for a minimal development config', () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.corsOrigins).toEqual([]);
    expect(cfg.databaseSsl).toBe(false);
    expect(cfg.logLevel).toBe('info');
  });

  it('splits and trims CORS origins', () => {
    const cfg = loadConfig({ ...base, CORS_ORIGINS: 'https://a.com, https://b.com ' });
    expect(cfg.corsOrigins).toEqual(['https://a.com', 'https://b.com']);
  });

  it('reports a missing DATABASE_URL', () => {
    expect(issuesFor({ COOKIE_SECRET: 'a'.repeat(32) }).join('\n')).toContain('DATABASE_URL');
  });

  it('rejects a COOKIE_SECRET shorter than 32 characters', () => {
    expect(issuesFor({ ...base, COOKIE_SECRET: 'short' }).join('\n')).toContain('COOKIE_SECRET');
  });

  it('requires CORS_ORIGINS in production and defaults SSL on', () => {
    expect(issuesFor({ ...base, NODE_ENV: 'production' }).join('\n')).toContain('CORS_ORIGINS');
    const cfg = loadConfig({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://shop.example' });
    expect(cfg.databaseSsl).toBe(true);
  });

  it('allows DATABASE_SSL to override the default', () => {
    expect(loadConfig({ ...base, DATABASE_SSL: 'true' }).databaseSsl).toBe(true);
  });

  it('rejects a non-numeric PORT', () => {
    expect(issuesFor({ ...base, PORT: 'abc' }).join('\n')).toContain('PORT');
  });

  it('reports every bad variable at once', () => {
    expect(issuesFor({ PORT: 'abc' }).length).toBeGreaterThanOrEqual(2);
  });

  it('treats empty variables (as in .env.example) as unset', () => {
    const cfg = loadConfig({ ...base, DATABASE_SSL: '', LOG_LEVEL: '', NODE_ENV: '', PORT: '', FIREBASE_PROJECT_ID: '' });
    expect(cfg.databaseSsl).toBe(false);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.port).toBe(3000);
  });
});
