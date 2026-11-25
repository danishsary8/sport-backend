import type { RequestHandler } from 'express';
import type { Config } from './config/env.js';
import type { Database } from './db/client.js';
import type { IdentityProvider } from './lib/identity.js';
import type { Logger } from './lib/logger.js';
import type { PaymentProvider } from './modules/payments/provider.js';
import type { Notifier } from './modules/notifications/notifier.js';
import { optionalAuth, optionalUser, requireAuth, requireUser } from './middleware/auth.js';
import { createRateLimitMiddleware, DEFAULT_RATE_LIMIT_WINDOW_MS } from './middleware/rateLimit.js';
import type { BootstrapAdmins } from './modules/users/repo.js';

/** Everything a feature router needs, built once per app. */
export interface AppContext {
  config: Config;
  logger: Logger;
  database: Database;
  identity: IdentityProvider;
  bootstrapAdmins: BootstrapAdmins;
  payments: PaymentProvider;
  notifiers: { telegram: Notifier; email: Notifier };
  /** requireAuth + requireUser: the route needs a signed-in, non-deleted user. */
  member: RequestHandler[];
  /** Guests allowed; with a valid token, req.auth and req.user are set (deleted accounts rejected). */
  guestOrMember: RequestHandler[];
  /** A per-IP limiter for one route (max requests per minute); a no-op when route limits are off. */
  routeLimit(bucket: string, maxPerMinute: number): RequestHandler;
}

export function createContext(deps: Omit<AppContext, 'member' | 'guestOrMember' | 'routeLimit'> & { routeLimits?: boolean }): AppContext {
  const { routeLimits = true, ...rest } = deps;
  return {
    ...rest,
    routeLimit: (bucket, maxPerMinute) =>
      routeLimits
        ? createRateLimitMiddleware({ bucket, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS, maxRequests: maxPerMinute })
        : (_req, _res, next) => next(),
    member: [requireAuth(deps.identity), requireUser(deps.database.db, deps.bootstrapAdmins, deps.identity)],
    guestOrMember: [optionalAuth(deps.identity), optionalUser(deps.database.db, deps.bootstrapAdmins)],
  };
}
