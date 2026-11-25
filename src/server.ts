import 'dotenv/config';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createDb, type Database } from './db/client.js';
import { createFirebaseIdentity, createUnconfiguredIdentity } from './lib/identity.js';
import { createLogger } from './lib/logger.js';
import { createTestIdentity } from './lib/testIdentity.js';
import { startScheduler } from './jobs/sweeper.js';
import { resendNotifier } from './modules/notifications/resend.js';
import { telegramNotifier } from './modules/notifications/telegram.js';
import { createPaymentProvider } from './modules/payments/provider.js';

const SHUTDOWN_GRACE_MS = 10_000;

export interface RunningServer {
  url: string;
  /** Whether the per-minute sweeper (payments, expiry, notifications) runs in this process. */
  jobsRunning: boolean;
  stop(): Promise<void>;
}

/** Boots the API. Throws ConfigError before touching the network if configuration is invalid. */
export async function start(env: NodeJS.ProcessEnv = process.env, hooks: { onDatabase?: (d: Database) => void } = {}): Promise<RunningServer> {
  const config = loadConfig(env);
  const logger = createLogger(config);
  const database = createDb(config, (err) => logger.error({ err }, 'Postgres pool error'));
  hooks.onDatabase?.(database);
  let identity = createUnconfiguredIdentity();
  if (config.authTestMode) {
    identity = createTestIdentity();
    logger.warn('AUTH_TEST_MODE is on: test sign-in tokens are accepted (never use this in production)');
  } else if (config.firebaseProjectId) {
    identity = createFirebaseIdentity({ projectId: config.firebaseProjectId, serviceAccount: config.firebaseServiceAccount });
  } else {
    logger.warn('FIREBASE_PROJECT_ID is not set: sign-in endpoints will answer 503 auth_unavailable');
  }
  const payments = createPaymentProvider(config);
  if (payments.name === 'fake') logger.warn('PayWay is not configured: using the fake payment provider (test payments only)');
  const notifiers = {
    telegram: telegramNotifier({ botToken: config.telegramBotToken, chatId: config.telegramChatId }),
    email: resendNotifier({ apiKey: config.resendApiKey, from: config.notificationFromEmail }),
  };
  const app = createApp({ config, logger, db: database, identity, payments, notifiers });

  const server = app.listen(config.port, '0.0.0.0');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    // e.g. the port is taken: don't leave the pool behind.
    await database.close();
    throw error;
  }
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  logger.info({ port, env: config.nodeEnv }, 'Sport Castle API listening');

  const scheduler = config.jobsEnabled
    ? startScheduler({
        database,
        payments,
        notifiers,
        logger,
        now: () => new Date(),
      })
    : null;

  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      logger.info('Shutting down');
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          logger.warn('Forcing open connections closed after grace period');
          server.closeAllConnections();
        }, SHUTDOWN_GRACE_MS);
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        // Idle keep-alive sockets would otherwise hold close() open.
        server.closeIdleConnections();
      });
      await scheduler?.stop();
      await database.close();
    })();
    return stopping;
  };

  return { url, jobsRunning: scheduler !== null, stop };
}

async function main(): Promise<void> {
  try {
    const server = await start();
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        server.stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      });
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
    } else {
      console.error('Fatal startup error:', error);
    }
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
