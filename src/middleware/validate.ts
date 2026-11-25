import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../lib/errors.js';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates and replaces req.body / req.query / req.params with the parsed values.
 * Object schemas strip unknown keys, so clients can never smuggle extra fields (e.g. prices).
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const issues: { path: string; message: string }[] = [];

    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        // req.query is a getter in Express 4's typings; assign through defineProperty for all parts.
        Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true, enumerable: true });
      } else {
        for (const issue of result.error.issues) {
          issues.push({ path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (issues.length > 0) {
      next(new AppError('validation_failed', 400, 'Validation failed', issues));
      return;
    }
    next();
  };
}
