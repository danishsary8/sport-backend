import type { Config } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import type { RateLimitStore } from '../../src/middleware/rateLimit.js';
import { FakePaymentProvider } from '../../src/modules/payments/fake.js';
import { FakeNotifier, type Notifier } from '../../src/modules/notifications/notifier.js';
import { fakeIdentity } from './fakeIdentity.js';
import { testConfig } from './testConfig.js';

/** App wired to the test database, a fake identity provider and fake payments, rate limiting off. */
export function memberApp(
  database: Database,
  fake = fakeIdentity(),
  opts: { payments?: FakePaymentProvider; logger?: Logger; config?: Partial<Config>; routeLimits?: boolean; rateLimitStore?: RateLimitStore; bootstrapAdmins?: { phones: string[]; emails: string[] }; notifiers?: { telegram: Notifier; email: Notifier } } = {},
) {
  const payments = opts.payments ?? new FakePaymentProvider();
  const app = createApp({
    config: testConfig(opts.config),
    logger: opts.logger ?? createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    db: database,
    identity: fake.provider,
    bootstrapAdmins: opts.bootstrapAdmins ?? { phones: [], emails: [] },
    rateLimit: { enabled: false, routes: opts.routeLimits ?? false },
    rateLimitStore: opts.rateLimitStore,
    payments,
    notifiers: opts.notifiers ?? { telegram: new FakeNotifier('telegram'), email: new FakeNotifier('email') },
  });
  return { app, fake, payments };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
