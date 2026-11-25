import { randomUUID } from 'node:crypto';
import { InvalidTokenError, type AuthClaims, type IdentityProvider } from '../../src/lib/identity.js';

/** In-memory IdentityProvider: mint opaque tokens for claims, record deleted users. */
export function fakeIdentity() {
  const tokens = new Map<string, AuthClaims>();
  const deleted: string[] = [];
  let failDelete = false;

  const provider: IdentityProvider = {
    async verifyIdToken(token) {
      const claims = tokens.get(token);
      if (!claims) throw new InvalidTokenError('unknown token');
      return claims;
    },
    async deleteUser(uid) {
      if (failDelete) throw new Error('firebase down');
      deleted.push(uid);
    },
  };

  return {
    provider,
    deleted,
    failDeletes() {
      failDelete = true;
    },
    /** Mints a token; unspecified claims default to a phone sign-in. */
    token(claims: Partial<AuthClaims> & { uid: string }): string {
      const token = `tok_${randomUUID()}`;
      tokens.set(token, {
        phone: null,
        email: null,
        emailVerified: false,
        name: null,
        picture: null,
        signInProvider: claims.phone ? 'phone' : 'google.com',
        ...claims,
      });
      return token;
    },
  };
}
