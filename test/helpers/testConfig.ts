import type { Config } from '../../src/config/env.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sport_test';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    databaseSsl: false,
    corsOrigins: ['https://shop.example'],
    cookieSecret: 'test-cookie-secret-test-cookie-secret',
    logLevel: 'fatal',
    firebaseProjectId: undefined,
    ...overrides,
  };
}
