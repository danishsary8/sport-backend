import { createHash } from 'node:crypto';
import { cert, getApp, getApps, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';

/** What the API needs to know about a signed-in Firebase user. */
export interface AuthClaims {
  uid: string;
  phone: string | null;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
  signInProvider: string | null;
}

export interface IdentityProvider {
  verifyIdToken(token: string): Promise<AuthClaims>;
  deleteUser(uid: string): Promise<void>;
}

export class InvalidTokenError extends Error {
  override name = 'InvalidTokenError';
}

export class IdentityUnavailableError extends Error {
  override name = 'IdentityUnavailableError';
}

export interface FirebaseAuthLike {
  verifyIdToken(token: string, checkRevoked?: boolean): Promise<DecodedIdToken>;
  deleteUser(uid: string): Promise<void>;
}

const CACHE_MS = 5 * 60 * 1000;
const CACHE_MAX = 5000;
const APP_NAME = 'sport-backend';

function toClaims(d: DecodedIdToken): AuthClaims {
  return {
    uid: d.uid,
    phone: d.phone_number ?? null,
    email: d.email ?? null,
    emailVerified: d.email_verified === true,
    name: typeof d.name === 'string' ? d.name : null,
    picture: d.picture ?? null,
    signInProvider: d.firebase?.sign_in_provider ?? null,
  };
}

function isFirebaseAuthError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.startsWith('auth/');
}

function defaultAuth(cfg: { projectId: string; serviceAccount?: object }): FirebaseAuthLike {
  const app = getApps().some((a) => a.name === APP_NAME)
    ? getApp(APP_NAME)
    : initializeApp(
        {
          projectId: cfg.projectId,
          ...(cfg.serviceAccount ? { credential: cert(cfg.serviceAccount as ServiceAccount) } : {}),
        },
        APP_NAME,
      );
  return getAuth(app);
}

/**
 * Verifies Firebase ID tokens. Revocation is checked when a service account is configured
 * (it needs credentials). Verified claims are cached per token for up to 5 minutes, never past expiry.
 */
export function createFirebaseIdentity(
  cfg: { projectId: string; serviceAccount?: object },
  overrides: { auth?: FirebaseAuthLike; nowMs?: () => number } = {},
): IdentityProvider {
  const checkRevoked = cfg.serviceAccount !== undefined;
  const now = overrides.nowMs ?? Date.now;
  let auth = overrides.auth;
  const cache = new Map<string, { claims: AuthClaims; until: number }>();

  const getAuthClient = () => (auth ??= defaultAuth(cfg));

  return {
    async verifyIdToken(token) {
      const key = createHash('sha256').update(token).digest('hex');
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.claims;
      cache.delete(key);

      let decoded: DecodedIdToken;
      try {
        decoded = await getAuthClient().verifyIdToken(token, checkRevoked);
      } catch (error) {
        if (isFirebaseAuthError(error)) throw new InvalidTokenError('Invalid or expired token');
        throw new IdentityUnavailableError('Identity service unavailable');
      }

      const claims = toClaims(decoded);
      const until = Math.min(decoded.exp * 1000, now() + CACHE_MS);
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { claims, until });
      return claims;
    },

    async deleteUser(uid) {
      try {
        await getAuthClient().deleteUser(uid);
      } catch (error) {
        if ((error as { code?: string })?.code === 'auth/user-not-found') return;
        throw error;
      }
    },
  };
}

/** Used when Firebase isn't configured (local dev without credentials): every call fails as unavailable. */
export function createUnconfiguredIdentity(): IdentityProvider {
  const fail = async (): Promise<never> => {
    throw new IdentityUnavailableError('Authentication is not configured');
  };
  return { verifyIdToken: fail, deleteUser: fail };
}
