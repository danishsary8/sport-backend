import type { Config } from '../../src/config/env.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sport_test';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    databaseSsl: false,
    databaseSslCa: undefined,
    corsOrigins: ['https://shop.example'],
    cookieSecret: 'test-cookie-secret-test-cookie-secret',
    logLevel: 'fatal',
    firebaseProjectId: undefined,
    firebaseServiceAccount: undefined,
    bootstrapAdminPhones: [],
    bootstrapAdminEmails: [],
    assetBaseUrl: '/assets/',
    paywayMerchantId: undefined,
    paywayApiKey: undefined,
    paywayBaseUrl: 'https://checkout-sandbox.payway.com.kh',
    paywayReturnUrl: undefined,
    paywayContinueUrl: 'https://shop.example/checkout/return',
    bakong: undefined,
    paymentsCashOnly: false,
    publicApiUrl: 'http://localhost:3000',
    telegramBotToken: undefined,
    telegramChatId: undefined,
    resendApiKey: undefined,
    anthropicApiKey: undefined,
    notificationFromEmail: undefined,
    jobsEnabled: false,
    authTestMode: false,
    trustProxyHops: 1,
    ...overrides,
  };
}
