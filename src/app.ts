import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Config } from './config.js';
import { createErrorHandler, notFoundHandler } from './lib/errors.js';
import type { Logger } from './lib/logger.js';
import { requestId } from './lib/request-id.js';
import { healthRoutes } from './modules/health/routes.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
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

  app.use(healthRoutes());

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
