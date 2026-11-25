import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { Logger } from './logger.js';

export const PROBLEM_BASE = 'https://api.sportcastle.dev/problems/';

export interface FieldError {
  path: string;
  message: string;
}

/** An error that maps directly to an RFC 9457 problem response. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly slug: string,
    public readonly title: string,
    public readonly detail?: string,
    public readonly errors?: FieldError[],
  ) {
    super(detail ?? title);
    this.name = 'ApiError';
  }

  get type(): string {
    return PROBLEM_BASE + this.slug;
  }

  static badRequest(detail: string, errors?: FieldError[]) {
    return new ApiError(400, 'validation-error', 'Bad Request', detail, errors);
  }
  static notFound(detail: string) {
    return new ApiError(404, 'not-found', 'Not Found', detail);
  }
  static conflict(detail: string) {
    return new ApiError(409, 'conflict', 'Conflict', detail);
  }
  static serviceUnavailable(detail: string) {
    return new ApiError(503, 'service-unavailable', 'Service Unavailable', detail);
  }
}

export function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}

function send(res: Response, req: Request, err: ApiError): void {
  res
    .status(err.status)
    .type('application/problem+json')
    .send(
      JSON.stringify({
        type: err.type,
        title: err.title,
        status: err.status,
        ...(err.detail ? { detail: err.detail } : {}),
        instance: req.originalUrl.split('?')[0],
        requestId: req.id,
        ...(err.errors?.length ? { errors: err.errors } : {}),
      }),
    );
}

export function notFoundHandler(req: Request, res: Response): void {
  send(res, req, ApiError.notFound(`No route for ${req.method} ${req.path}`));
}

/** Last middleware: turns every thrown error into a problem+json response. */
export function createErrorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ApiError) return send(res, req, err);
    if (err instanceof ZodError) {
      return send(res, req, ApiError.badRequest('The request is not valid.', zodToFieldErrors(err)));
    }
    const bodyError = err as { type?: string; status?: number };
    if (bodyError?.type === 'entity.too.large') {
      return send(res, req, new ApiError(413, 'payload-too-large', 'Payload Too Large', 'Request body must be 100 kB or less.'));
    }
    if (bodyError?.type === 'entity.parse.failed') {
      return send(res, req, new ApiError(400, 'malformed-json', 'Bad Request', 'Request body is not valid JSON.'));
    }
    logger.error({ err, requestId: req.id }, 'Unhandled error');
    send(res, req, new ApiError(500, 'internal-error', 'Internal Server Error', 'Something went wrong on our side.'));
  };
}
