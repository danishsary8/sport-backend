import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const VALID_ID = /^[A-Za-z0-9-]{8,64}$/;

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

/** Accepts a safe incoming X-Request-Id or creates one, and echoes it on the response. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  req.id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
