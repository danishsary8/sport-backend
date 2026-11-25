import type { RequestHandler } from 'express';
import type { Db } from '../db/client.js';
import type { UserRole } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { IdentityUnavailableError, InvalidTokenError, type IdentityProvider } from '../lib/identity.js';
import { upsertFromClaims, type BootstrapAdmins } from '../modules/users/repo.js';

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function mapIdentityError(error: unknown): AppError {
  if (error instanceof InvalidTokenError) return new AppError('invalid_token', 401, 'Invalid or expired sign-in');
  if (error instanceof IdentityUnavailableError) {
    return new AppError('auth_unavailable', 503, 'Sign-in is temporarily unavailable');
  }
  throw error;
}

/** Verifies the Firebase ID token and sets req.auth. */
export function requireAuth(identity: IdentityProvider): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerToken(req.get('authorization'));
    if (!token) throw new AppError('unauthenticated', 401, 'Sign in required');
    try {
      req.auth = await identity.verifyIdToken(token);
    } catch (error) {
      throw mapIdentityError(error);
    }
    next();
  };
}

/**
 * For routes open to guests. No token → guest. A token that is sent but invalid or expired is
 * rejected (401) so the client refreshes it, instead of silently showing a signed-in member an
 * empty guest bag.
 */
export function optionalAuth(identity: IdentityProvider): RequestHandler {
  return async (req, _res, next) => {
    const token = bearerToken(req.get('authorization'));
    if (token) {
      try {
        req.auth = await identity.verifyIdToken(token);
      } catch (error) {
        throw mapIdentityError(error);
      }
    }
    next();
  };
}

/** Loads (creating on first use) the Postgres user for req.auth; rejects deleted accounts. */
export function requireUser(db: Db, bootstrap: BootstrapAdmins, identity: IdentityProvider): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) throw new AppError('unauthenticated', 401, 'Sign in required');
    const { user, created } = await upsertFromClaims(db, req.auth, bootstrap);
    if (user.deletedAt) {
      // The Firebase user should be gone; if deletion failed earlier, retry so the person
      // can sign up again with the same phone. Best effort, never blocks the response.
      void identity.deleteUser(user.firebaseUid).catch(() => {});
      throw new AppError('account_deleted', 403, 'This account has been deleted');
    }
    req.user = user;
    req.userCreated = created;
    next();
  };
}

/** For routes open to guests: when a valid token was sent, load the member like requireUser. */
export function optionalUser(db: Db, bootstrap: BootstrapAdmins): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) {
      next();
      return;
    }
    const { user } = await upsertFromClaims(db, req.auth, bootstrap);
    if (user.deletedAt) throw new AppError('account_deleted', 403, 'This account has been deleted');
    req.user = user;
    next();
  };
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new AppError('forbidden', 403, 'You do not have access to this');
    }
    next();
  };
}
