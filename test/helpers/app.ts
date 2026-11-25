import { createApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { createLogger } from '../../src/lib/logger.js';
import { fakeIdentity } from './fakeIdentity.js';
import { testConfig } from './testConfig.js';

/** App wired to the test database and a fake identity provider, rate limiting off. */
export function memberApp(database: Database, fake = fakeIdentity()) {
  const app = createApp({
    config: testConfig(),
    logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    db: database,
    identity: fake.provider,
    bootstrapAdmins: { phones: [], emails: [] },
    rateLimit: { enabled: false },
  });
  return { app, fake };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
