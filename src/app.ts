import { sql } from 'drizzle-orm';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { createErrorHandler, notFoundHandler } from './lib/errors.js';
import type { Logger } from './lib/logger.js';
import { requestId } from './lib/request-id.js';
import { catalogRoutes } from './modules/catalog/routes.js';
import { healthRoutes } from './modules/health/routes.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  db?: Db;
  /** Readiness probe; defaults to `select 1` on `db` with a 2 s timeout. */
  checkDb?: () => Promise<void>;
}

const READY_TIMEOUT_MS = 2000;

function defaultCheckDb(db: Db | undefined): () => Promise<void> {
  return async () => {
    if (!db) throw new Error('No database configured');
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Database check timed out')), READY_TIMEOUT_MS)),
    ]);
  };
}

/** Builds the Express app without listening, so tests can drive it directly. */
export function createApp(deps: AppDeps): Express {
  const { logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      customProps: (req) => ({ requestId: (req as express.Request).id }),
    }),
  );
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRoutes({ checkDb: deps.checkDb ?? defaultCheckDb(deps.db) }));
  app.use('/v1', catalogRoutes(deps.db));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
