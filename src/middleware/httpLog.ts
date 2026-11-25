import type { Request, RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../lib/logger.js';

const QUIET_PATHS = new Set(['/health', '/ready']);

/**
 * One access line per request. Server errors are logged as `warn` here because errorHandler already
 * logs the error itself once at `error`. Platform probes are not logged at all.
 */
export function httpLogger(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req) => (req as Request).id,
    autoLogging: { ignore: (req) => QUIET_PATHS.has((req.url ?? '').split('?')[0] ?? '') },
    customLogLevel: (_req, res) => (res.statusCode >= 500 ? 'warn' : 'info'),
    customAttributeKeys: { err: 'unusedErr' },
    serializers: { unusedErr: () => undefined },
  });
}
