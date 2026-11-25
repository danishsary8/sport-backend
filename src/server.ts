import 'dotenv/config';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config/env.js';
import { createDb } from './db/client.js';
import { createLogger } from './lib/logger.js';

const SHUTDOWN_GRACE_MS = 10_000;

export interface RunningServer {
  url: string;
  stop(): Promise<void>;
}

/** Boots the API. Throws ConfigError before touching the network if configuration is invalid. */
export async function start(env: NodeJS.ProcessEnv = process.env): Promise<RunningServer> {
  const config = loadConfig(env);
  const logger = createLogger(config);
  const database = createDb(config, (err) => logger.error({ err }, 'Postgres pool error'));
  const app = createApp({ config, logger, db: database });

  const server = app.listen(config.port, '0.0.0.0');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  logger.info({ port, env: config.nodeEnv }, 'Sport Castle API listening');

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
      await database.close();
    })();
    return stopping;
  };

  return { url, stop };
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
