import type { RequestHandler } from 'express';
import type { Config } from './config/env.js';
import type { Database } from './db/client.js';
import type { IdentityProvider } from './lib/identity.js';
import type { Logger } from './lib/logger.js';
import type { PaymentProvider } from './modules/payments/provider.js';
import { optionalAuth, optionalUser, requireAuth, requireUser } from './middleware/auth.js';
import type { BootstrapAdmins } from './modules/users/repo.js';

/** Everything a feature router needs, built once per app. */
export interface AppContext {
  config: Config;
  logger: Logger;
  database: Database;
  identity: IdentityProvider;
  bootstrapAdmins: BootstrapAdmins;
  payments: PaymentProvider;
  /** requireAuth + requireUser: the route needs a signed-in, non-deleted user. */
  member: RequestHandler[];
  /** Guests allowed; with a valid token, req.auth and req.user are set (deleted accounts rejected). */
  guestOrMember: RequestHandler[];
}

export function createContext(deps: Omit<AppContext, 'member' | 'guestOrMember'>): AppContext {
  return {
    ...deps,
    member: [requireAuth(deps.identity), requireUser(deps.database.db, deps.bootstrapAdmins, deps.identity)],
    guestOrMember: [optionalAuth(deps.identity), optionalUser(deps.database.db, deps.bootstrapAdmins)],
  };
}
