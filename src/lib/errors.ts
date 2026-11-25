import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from './logger.js';

/** An error that is safe to show to the client: stable code, HTTP status, human message. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('not_found', 404, 'Not found'));
};

/** Maps body-parser failures onto AppError so they share the standard shape. */
function fromBodyParser(err: unknown): AppError | undefined {
  if (typeof err !== 'object' || err === null || !('type' in err)) return undefined;
  switch ((err as { type?: string }).type) {
    case 'entity.parse.failed':
      return new AppError('invalid_json', 400, 'Malformed JSON request body');
    case 'entity.too.large':
      return new AppError('payload_too_large', 413, 'Request body is too large');
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError('unsupported_encoding', 415, 'Unsupported request encoding');
    default:
      return undefined;
  }
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const appError = err instanceof AppError ? err : fromBodyParser(err);

    if (appError) {
      logger.debug({ reqId: req.id, code: appError.code, status: appError.status }, appError.message);
      res.status(appError.status).json({
        error: {
          code: appError.code,
          message: appError.message,
          ...(appError.details === undefined ? {} : { details: appError.details }),
        },
      });
      return;
    }

    logger.error({ reqId: req.id, err }, 'Unhandled error');
    res.status(500).json({
      error: { code: 'internal_error', message: 'Internal server error', requestId: req.id },
    });
  };
}
