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
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://shop.example',
      FIREBASE_PROJECT_ID: 'p',
      FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}',
      PAYWAY_MERCHANT_ID: 'm',
      PAYWAY_API_KEY: 'k',
      PAYWAY_RETURN_URL: 'https://api.shop.example/v1/webhooks/payway',
      PAYWAY_CONTINUE_URL: 'https://shop.example/checkout/return',
    });
    expect(cfg.databaseSsl).toBe(true);
  });

  describe('payments and notifications', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://shop.example',
      FIREBASE_PROJECT_ID: 'p',
      FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"p"}',
    };

    it('requires PayWay credentials in production', () => {
      const issues = issuesFor(prod).join('\n');
      expect(issues).toContain('PAYWAY_MERCHANT_ID');
      expect(issues).toContain('PAYWAY_API_KEY');
    });

    it('allows a cash-only shop to run without PayWay', () => {
      expect(loadConfig({ ...prod, PAYMENT_METHODS_CASH_ONLY: 'true' }).paymentsCashOnly).toBe(true);
    });

    it('needs the merchant id and key together', () => {
      expect(issuesFor({ ...base, PAYWAY_MERCHANT_ID: 'm' }).join('\n')).toContain('PAYWAY_API_KEY');
    });

    it('defaults to the PayWay sandbox and runs jobs', () => {
      const cfg = loadConfig(base);
      expect(cfg.paywayBaseUrl).toBe('https://checkout-sandbox.payway.com.kh');
      expect(cfg.jobsEnabled).toBe(true);
      expect(cfg.publicApiUrl).toBe('http://localhost:3000');
      expect(loadConfig({ ...base, JOBS_ENABLED: 'false' }).jobsEnabled).toBe(false);
    });

    it('reads Telegram and Resend settings', () => {
      const cfg = loadConfig({ ...base, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '-100', RESEND_API_KEY: 'r', NOTIFICATION_FROM_EMAIL: 'Shop <shop@example.com>' });
      expect(cfg).toMatchObject({ telegramBotToken: 't', telegramChatId: '-100', resendApiKey: 'r', notificationFromEmail: 'Shop <shop@example.com>' });
    });
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

  it('rejects the .env.example placeholder COOKIE_SECRET in production', () => {
    const env = {
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://shop.example',
      COOKIE_SECRET: 'change-me-to-32-or-more-random-characters',
    };
    expect(issuesFor(env).join('\n')).toContain('COOKIE_SECRET');
  });

  it('requires Firebase credentials in production', () => {
    const prod = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://shop.example' };
    const issues = issuesFor(prod).join('\n');
    expect(issues).toContain('FIREBASE_PROJECT_ID');
    expect(issues).toContain('FIREBASE_SERVICE_ACCOUNT_JSON');
  });

  it('rejects a service account that is not valid JSON', () => {
    expect(issuesFor({ ...base, FIREBASE_SERVICE_ACCOUNT_JSON: '{nope' }).join('\n')).toContain(
      'FIREBASE_SERVICE_ACCOUNT_JSON',
    );
  });

  it('parses a service account and bootstrap admin lists', () => {
    const sa = { project_id: 'p', client_email: 'x@p.iam.gserviceaccount.com', private_key: 'k' };
    const cfg = loadConfig({
      ...base,
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa),
      BOOTSTRAP_ADMIN_PHONES: '012 345 678, +85596889217',
      BOOTSTRAP_ADMIN_EMAILS: ' Owner@Example.com ',
    });
    expect(cfg.firebaseServiceAccount).toEqual(sa);
    expect(cfg.bootstrapAdminPhones).toEqual(['+85512345678', '+85596889217']);
    expect(cfg.bootstrapAdminEmails).toEqual(['owner@example.com']);
  });

  it('rejects an invalid bootstrap admin phone', () => {
    expect(issuesFor({ ...base, BOOTSTRAP_ADMIN_PHONES: '123' }).join('\n')).toContain('BOOTSTRAP_ADMIN_PHONES');
  });
});
