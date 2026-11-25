import { normalizePhone } from './phone.js';
import { InvalidTokenError, type AuthClaims, type IdentityProvider } from './identity.js';

/** Marks the identity provider used for end-to-end tests; createApp refuses it in production. */
export const TEST_IDENTITY = Symbol('test-identity');

/**
 * Sign-in for end-to-end tests without Firebase. Tokens are `test:<uid>:<phone|->:<email|->[:<name>]`,
 * e.g. `test:e2e-alice:+85512000001:-`. Only used when AUTH_TEST_MODE=true outside production.
 */
export function createTestIdentity(): IdentityProvider & { [TEST_IDENTITY]: true } {
  return {
    [TEST_IDENTITY]: true,
    async verifyIdToken(token: string): Promise<AuthClaims> {
      const parts = token.split(':');
      if (parts.length < 4 || parts.length > 5 || parts[0] !== 'test') throw new InvalidTokenError('not a test token');
      const [, uid, phoneRaw, emailRaw, nameRaw] = parts;
      if (!uid || !/^[A-Za-z0-9_-]{1,64}$/.test(uid)) throw new InvalidTokenError('bad uid');
      const phone = phoneRaw && phoneRaw !== '-' ? normalizePhone(phoneRaw) : null;
      if (phoneRaw && phoneRaw !== '-' && !phone) throw new InvalidTokenError('bad phone');
      const email = emailRaw && emailRaw !== '-' ? emailRaw.toLowerCase() : null;
      if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) throw new InvalidTokenError('bad email');
      return {
        uid,
        phone,
        email,
        emailVerified: email !== null,
        name: nameRaw ? decodeURIComponent(nameRaw) : null,
        picture: null,
        signInProvider: phone ? 'phone' : 'google.com',
      };
    },
    async deleteUser() {},
  };
}

export function isTestIdentity(identity: IdentityProvider): boolean {
  return (identity as Partial<Record<typeof TEST_IDENTITY, boolean>>)[TEST_IDENTITY] === true;
}
