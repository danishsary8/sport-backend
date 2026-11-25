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

/**
 * What to log for an unexpected error. Database errors carry the query parameters (names, phones,
 * addresses) in their message and `params`, and row values in `detail`: keep only the driver's own
 * message, code and the stack.
 */
export function safeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: String(err).slice(0, 200) };
  const cause = (err as { cause?: unknown }).cause;
  const isQueryError = 'params' in err || 'query' in err || err.message.startsWith('Failed query');
  if (isQueryError && cause instanceof Error) {
    return { name: err.name, message: cause.message, code: (cause as { code?: unknown }).code, table: (cause as { table?: unknown }).table, constraint: (cause as { constraint?: unknown }).constraint, stack: err.stack?.split('\n').slice(1).join('\n') };
  }
  return { name: err.name, message: err.message, code: (err as { code?: unknown }).code, stack: err.stack };
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('not_found', 404, 'Not found'));
};

/** Maps body-parser failures onto AppError so they share the standard shape. */
function fromBodyParser(err: unknown): AppError | undefined {
  if (typeof err !== 'object' || err === null || !('type' in err)) return undefined;
  switch ((err as { type?: string }).type) {
    case 'request.aborted':
      return new AppError('request_aborted', 400, 'The request was interrupted');
    case 'request.size.invalid':
    case 'entity.verify.failed':
      return new AppError('invalid_body', 400, 'The request body could not be read');
    case 'parameters.too.many':
      return new AppError('payload_too_large', 413, 'Request body is too large');
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

    logger.error({ reqId: req.id, err: safeError(err) }, 'Unhandled error');
    res.status(500).json({
      error: { code: 'internal_error', message: 'Internal server error', requestId: req.id },
    });
  };
}
