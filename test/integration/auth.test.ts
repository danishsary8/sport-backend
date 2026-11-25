import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Database } from '../../src/db/client.js';
import { createUnconfiguredIdentity } from '../../src/lib/identity.js';
import { createLogger } from '../../src/lib/logger.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';
import { fakeIdentity } from '../helpers/fakeIdentity.js';
import { testConfig } from '../helpers/testConfig.js';

let database: Database;
let fake: ReturnType<typeof fakeIdentity>;

beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetDb(database);
  fake = fakeIdentity();
});

function app(bootstrapAdmins = { phones: [] as string[], emails: [] as string[] }) {
  return createApp({
    config: testConfig(),
    logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    db: database,
    identity: fake.provider,
    bootstrapAdmins,
    rateLimit: { enabled: false },
  });
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function userCount(): Promise<number> {
  const r = await database.pool.query<{ n: string }>('select count(*)::text as n from users');
  return Number(r.rows[0]?.n);
}

describe('authentication errors', () => {
  it('requires a bearer token', async () => {
    const res = await request(app()).get('/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
  });

  it('rejects an unknown token', async () => {
    const res = await request(app()).get('/v1/me').set(bearer('junk'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_token');
  });

  it('reports auth_unavailable when Firebase is not configured', async () => {
    const unconfigured = createApp({
      config: testConfig(),
      logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
      db: database,
      identity: createUnconfiguredIdentity(),
      bootstrapAdmins: { phones: [], emails: [] },
    });
    const res = await request(unconfigured).get('/v1/me').set(bearer('anything'));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('auth_unavailable');
  });
});

describe('POST /v1/auth/session', () => {
  it('creates a customer on first phone sign-in, then finds the same user', async () => {
    const token = fake.token({ uid: 'u-phone', phone: '+85512345678' });
    const first = await request(app()).post('/v1/auth/session').set(bearer(token));
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(true);
    expect(first.body.user).toMatchObject({ phone: '+85512345678', role: 'customer', phoneVerified: true });

    const second = await request(app()).post('/v1/auth/session').set(bearer(token));
    expect(second.body.created).toBe(false);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it('stores a phone added later to a Google account', async () => {
    const google = fake.token({ uid: 'u-g', email: 'dara@example.com', emailVerified: true, name: 'Dara' });
    const before = await request(app()).post('/v1/auth/session').set(bearer(google));
    expect(before.body.user).toMatchObject({ phone: null, phoneVerified: false, email: 'dara@example.com', fullName: 'Dara' });

    const linked = fake.token({ uid: 'u-g', email: 'dara@example.com', emailVerified: true, phone: '+85596889217' });
    const me = await request(app()).get('/v1/me').set(bearer(linked));
    expect(me.body.user).toMatchObject({ phone: '+85596889217', phoneVerified: true });
  });

  it('releases a phone still held by a deleted account', async () => {
    await database.pool.query(
      "insert into users (firebase_uid, phone_e164, deleted_at) values ('old', '+85599999999', now())",
    );
    const res = await request(app())
      .post('/v1/auth/session')
      .set(bearer(fake.token({ uid: 'new', phone: '+85599999999' })));
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe('+85599999999');
    const old = await database.pool.query("select phone_e164 from users where firebase_uid = 'old'");
    expect(old.rows[0]?.phone_e164).toBeNull();
  });

  it('promotes bootstrap admins on every login', async () => {
    const admins = { phones: ['+85512345678'], emails: [] };
    const token = fake.token({ uid: 'boss', phone: '+85512345678' });
    const res = await request(app(admins)).post('/v1/auth/session').set(bearer(token));
    expect(res.body.user.role).toBe('admin');

    await database.pool.query("update users set role = 'staff' where firebase_uid = 'boss'");
    const again = await request(app(admins)).post('/v1/auth/session').set(bearer(token));
    expect(again.body.user.role).toBe('admin');
  });

  it('ignores an unverified bootstrap email', async () => {
    const admins = { phones: [], emails: ['owner@example.com'] };
    const token = fake.token({ uid: 'x', email: 'owner@example.com', emailVerified: false });
    const res = await request(app(admins)).post('/v1/auth/session').set(bearer(token));
    expect(res.body.user.role).toBe('customer');
    expect(res.body.user.email).toBeNull();
  });

  it('creates exactly one user when first requests arrive together', async () => {
    const token = fake.token({ uid: 'racer', phone: '+85511222333' });
    const [a, b] = await Promise.all([
      request(app()).post('/v1/auth/session').set(bearer(token)),
      request(app()).get('/v1/me').set(bearer(token)),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it('locks out a deleted account', async () => {
    const token = fake.token({ uid: 'gone', phone: '+85512000000' });
    await request(app()).post('/v1/auth/session').set(bearer(token));
    await database.pool.query("update users set deleted_at = now(), phone_e164 = null where firebase_uid = 'gone'");
    const res = await request(app()).get('/v1/me').set(bearer(token));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('account_deleted');
    const row = await database.pool.query("select phone_e164 from users where firebase_uid = 'gone'");
    expect(row.rows[0]?.phone_e164).toBeNull();
  });

  it('moves a phone from an old live account to the uid that now owns it in Firebase', async () => {
    await database.pool.query("insert into users (firebase_uid, phone_e164) values ('stale', '+85577777777')");
    const res = await request(app())
      .post('/v1/auth/session')
      .set(bearer(fake.token({ uid: 'owner', phone: '+85577777777' })));
    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBe('+85577777777');
    const stale = await database.pool.query("select phone_e164 from users where firebase_uid = 'stale'");
    expect(stale.rows[0]?.phone_e164).toBeNull();
  });

  it('clears the phone when the token no longer carries one (unlinked)', async () => {
    await request(app()).post('/v1/auth/session').set(bearer(fake.token({ uid: 'u', phone: '+85566666666', email: 'u@x.com', emailVerified: true })));
    const me = await request(app()).get('/v1/me').set(bearer(fake.token({ uid: 'u', email: 'u@x.com', emailVerified: true })));
    expect(me.body.user).toMatchObject({ phone: null, phoneVerified: false });
  });

  it('retries deleting the Firebase user when a deleted account signs in again', async () => {
    const token = fake.token({ uid: 'ghost', phone: '+85555555555' });
    await request(app()).post('/v1/auth/session').set(bearer(token));
    await database.pool.query("update users set deleted_at = now(), phone_e164 = null where firebase_uid = 'ghost'");
    const res = await request(app()).get('/v1/me').set(bearer(token));
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.deleted).toContain('ghost');
  });
});
