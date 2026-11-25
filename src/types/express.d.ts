import type { UserRow } from '../db/schema/index.js';
import type { AuthClaims } from '../lib/identity.js';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id set by the requestId middleware. */
      id: string;
      /** Raw request body bytes, kept for webhook signature checks. */
      rawBody?: Buffer;
      /** Verified Firebase claims (requireAuth / optionalAuth). */
      auth?: AuthClaims;
      /** The signed-in user's row (requireUser). */
      user?: UserRow;
      /** True when requireUser created the row on this request. */
      userCreated?: boolean;
    }
  }
}

export {};
