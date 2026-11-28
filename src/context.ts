import type { RequestHandler } from 'express';
import type { Config } from './config/env.js';
import type { Database } from './db/client.js';
import type { IdentityProvider } from './lib/identity.js';
import type { Logger } from './lib/logger.js';
import type { PaymentProvider } from './modules/payments/provider.js';
import type { ImageFetcher } from './modules/admin/remoteImage.js';
import type { SmartSearch } from './modules/search/smartSearch.js';
import type { Notifier } from './modules/notifications/notifier.js';
import { optionalAuth, optionalUser, requireAuth, requireUser } from './middleware/auth.js';
import { createRateLimitMiddleware, DEFAULT_RATE_LIMIT_WINDOW_MS, InMemoryRateLimitStore, type RateLimitStore } from './middleware/rateLimit.js';
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
  /** Downloads photos from web links (CSV import). */
  imageFetcher: ImageFetcher;
  /** Reads a shopper's search words into filters; null when no ANTHROPIC_API_KEY is set. */
  smartSearch: SmartSearch | null;
  /** requireAuth + requireUser: the route needs a signed-in, non-deleted user. */
  member: RequestHandler[];
  /** Guests allowed; with a valid token, req.auth and req.user are set (deleted accounts rejected). */
  guestOrMember: RequestHandler[];
  /**
   * A limiter for one route (max requests per minute), keyed by client IP or, after auth, by member id
   * (guests pass the per-member limiter). A no-op when route limits are off.
   */
  routeLimit(bucket: string, maxPerMinute: number, by?: 'ip' | 'user'): RequestHandler;
}

export function createContext(deps: Omit<AppContext, 'member' | 'guestOrMember' | 'routeLimit'> & { routeLimits?: boolean; rateLimitStore?: RateLimitStore }): AppContext {
  const { routeLimits = true, rateLimitStore, ...rest } = deps;
  const store = rateLimitStore ?? new InMemoryRateLimitStore();
  return {
    ...rest,
    routeLimit: (bucket, maxPerMinute, by = 'ip') =>
      routeLimits
        ? createRateLimitMiddleware({
            bucket,
            windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
            maxRequests: maxPerMinute,
            store,
            ...(by === 'user' ? { keyGenerator: (req) => `user:${req.user?.id ?? ''}`, skip: (req) => !req.user } : {}),
          })
        : (_req, _res, next) => next(),
    member: [requireAuth(deps.identity), requireUser(deps.database.db, deps.bootstrapAdmins, deps.identity)],
    guestOrMember: [optionalAuth(deps.identity), optionalUser(deps.database.db, deps.bootstrapAdmins)],
  };
}
