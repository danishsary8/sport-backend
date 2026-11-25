import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const SAFE_ID = /^[\w-]{8,64}$/;

/** Reuses a well-formed inbound X-Request-Id (e.g. from a load balancer) or makes a new one. */
export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get('x-request-id');
  req.id = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};
