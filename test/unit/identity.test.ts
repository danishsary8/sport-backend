import { describe, expect, it, vi } from 'vitest';
import {
  createFirebaseIdentity,
  IdentityUnavailableError,
  InvalidTokenError,
  type FirebaseAuthLike,
} from '../../src/lib/identity.js';

const nowSec = 1_800_000_000;

function decoded(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'u1',
    phone_number: '+85512345678',
    email: 'a@example.com',
    email_verified: true,
    name: 'Dara',
    picture: 'https://img/p.png',
    exp: nowSec + 3600,
    firebase: { sign_in_provider: 'phone' },
    ...overrides,
  };
}

function stubAuth(impl: FirebaseAuthLike['verifyIdToken']): FirebaseAuthLike {
  return { verifyIdToken: vi.fn(impl), deleteUser: vi.fn(async () => {}) };
}

describe('createFirebaseIdentity', () => {
  it('maps Firebase claims', async () => {
    const auth = stubAuth(async () => decoded() as never);
    const identity = createFirebaseIdentity({ projectId: 'p' }, { auth, nowMs: () => nowSec * 1000 });
    await expect(identity.verifyIdToken('t')).resolves.toEqual({
      uid: 'u1',
      phone: '+85512345678',
      email: 'a@example.com',
      emailVerified: true,
      name: 'Dara',
      picture: 'https://img/p.png',
      signInProvider: 'phone',
    });
  });

  it('caches a verified token', async () => {
    const auth = stubAuth(async () => decoded() as never);
    const identity = createFirebaseIdentity({ projectId: 'p' }, { auth, nowMs: () => nowSec * 1000 });
    await identity.verifyIdToken('t');
    await identity.verifyIdToken('t');
    expect(auth.verifyIdToken).toHaveBeenCalledTimes(1);
  });

  it('re-verifies after the cache window (5 minutes)', async () => {
    let now = nowSec * 1000;
    const auth = stubAuth(async () => decoded() as never);
    const identity = createFirebaseIdentity({ projectId: 'p' }, { auth, nowMs: () => now });
    await identity.verifyIdToken('t');
    now += 5 * 60 * 1000 + 1;
    await identity.verifyIdToken('t');
    expect(auth.verifyIdToken).toHaveBeenCalledTimes(2);
  });

  it('never caches past the token expiry', async () => {
    let now = nowSec * 1000;
    const auth = stubAuth(async () => decoded({ exp: nowSec + 60 }) as never);
    const identity = createFirebaseIdentity({ projectId: 'p' }, { auth, nowMs: () => now });
    await identity.verifyIdToken('t');
    now += 61 * 1000;
    await identity.verifyIdToken('t');
    expect(auth.verifyIdToken).toHaveBeenCalledTimes(2);
  });

  it('turns Firebase auth errors into InvalidTokenError', async () => {
    const auth = stubAuth(async () => {
      throw Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' });
    });
    const identity = createFirebaseIdentity({ projectId: 'p' }, { auth });
    await expect(identity.verifyIdToken('t')).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('turns other failures into IdentityUnavailableError', async () => {
    const auth = stubAuth(async () => {
      throw new Error('ECONNRESET');
    });
    const identity = createFirebaseIdentity({ projectId: 'p' }, { auth });
    await expect(identity.verifyIdToken('t')).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  it('checks revocation only when a service account is configured', async () => {
    const auth = stubAuth(async () => decoded() as never);
    await createFirebaseIdentity({ projectId: 'p' }, { auth }).verifyIdToken('a');
    expect(auth.verifyIdToken).toHaveBeenLastCalledWith('a', false);
    await createFirebaseIdentity({ projectId: 'p', serviceAccount: {} }, { auth }).verifyIdToken('b');
    expect(auth.verifyIdToken).toHaveBeenLastCalledWith('b', true);
  });
});
