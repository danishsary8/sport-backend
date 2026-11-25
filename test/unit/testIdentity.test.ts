import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/lib/logger.js';
import { createTestIdentity } from '../../src/lib/testIdentity.js';
import { testConfig } from '../helpers/testConfig.js';

describe('test sign-in', () => {
  const identity = createTestIdentity();

  it('turns a test token into phone claims', async () => {
    expect(await identity.verifyIdToken('test:e2e-alice:+85512000001:-')).toMatchObject({
      uid: 'e2e-alice',
      phone: '+85512000001',
      email: null,
      signInProvider: 'phone',
    });
  });

  it('turns a token without a phone into Google claims with a verified email', async () => {
    expect(await identity.verifyIdToken('test:e2e-bob:-:bob@example.com:Bob%20Smith')).toMatchObject({
      uid: 'e2e-bob',
      phone: null,
      email: 'bob@example.com',
      emailVerified: true,
      name: 'Bob Smith',
      signInProvider: 'google.com',
    });
  });

  it('rejects anything else', async () => {
    for (const bad of ['', 'abc', 'test:', 'test::-:-', 'test:x:not-a-phone:-', 'eyJhbGciOi.real.jwt']) {
      await expect(identity.verifyIdToken(bad)).rejects.toMatchObject({ name: 'InvalidTokenError' });
    }
  });
});

describe('never in production', () => {
  const base = { DATABASE_URL: 'postgres://x', COOKIE_SECRET: 'a'.repeat(32) };

  it('refuses AUTH_TEST_MODE in a production config', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_TEST_MODE: 'true', PAYMENT_METHODS_CASH_ONLY: 'true', CORS_ORIGINS: 'https://x', FIREBASE_PROJECT_ID: 'p', FIREBASE_SERVICE_ACCOUNT_JSON: '{}' })).toThrow(/AUTH_TEST_MODE/);
    expect(loadConfig({ ...base, AUTH_TEST_MODE: 'true' }).authTestMode).toBe(true);
    expect(loadConfig(base).authTestMode).toBe(false);
  });

  it('refuses to build a production app with the test identity', () => {
    expect(() =>
      createApp({
        config: testConfig({ nodeEnv: 'production' }),
        logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
        db: {} as never,
        identity: createTestIdentity(),
      }),
    ).toThrow(/test sign-in/i);
  });
});
