import type { Config } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import { FakePaymentProvider } from '../../src/modules/payments/fake.js';
import { fakeIdentity } from './fakeIdentity.js';
import { testConfig } from './testConfig.js';

/** App wired to the test database, a fake identity provider and fake payments, rate limiting off. */
export function memberApp(
  database: Database,
  fake = fakeIdentity(),
  opts: { payments?: FakePaymentProvider; logger?: Logger; config?: Partial<Config>; routeLimits?: boolean } = {},
) {
  const payments = opts.payments ?? new FakePaymentProvider();
  const app = createApp({
    config: testConfig(opts.config),
    logger: opts.logger ?? createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    db: database,
    identity: fake.provider,
    bootstrapAdmins: { phones: [], emails: [] },
    rateLimit: { enabled: false, routes: opts.routeLimits ?? false },
    payments,
  });
  return { app, fake, payments };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
