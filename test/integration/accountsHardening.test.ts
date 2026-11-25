import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { phnomPenhAddress } from '../helpers/checkout.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetDb(database);
});

describe('signing in again', () => {
  it('does not rewrite the user row when nothing changed', async () => {
    const ctx = memberApp(database);
    const token = ctx.fake.token({ uid: 'quiet-user', phone: '+85512009991', name: 'Quiet' });
    await request(ctx.app).post('/v1/auth/session').set(bearer(token)).expect(200);
    const first = (await q("select updated_at from users where firebase_uid = 'quiet-user'")).rows[0].updated_at;
    await new Promise((r) => setTimeout(r, 20));
    await request(ctx.app).get('/v1/me').set(bearer(token)).expect(200);
    await request(ctx.app).post('/v1/auth/session').set(bearer(token)).expect(200);
    expect((await q("select updated_at from users where firebase_uid = 'quiet-user'")).rows[0].updated_at).toEqual(first);
  });

  it('still updates the row when a claim changes', async () => {
    const ctx = memberApp(database);
    await request(ctx.app).post('/v1/auth/session').set(bearer(ctx.fake.token({ uid: 'changing', phone: '+85512009992' }))).expect(200);
    await request(ctx.app).post('/v1/auth/session').set(bearer(ctx.fake.token({ uid: 'changing', phone: '+85512009993' }))).expect(200);
    expect((await q("select phone_e164 from users where firebase_uid = 'changing'")).rows[0].phone_e164).toBe('+85512009993');
  });
});

describe('bootstrap admins', () => {
  it('refuses to demote an admin who is in BOOTSTRAP_ADMIN_PHONES', async () => {
    const ctx = memberApp(database, undefined, { bootstrapAdmins: { phones: ['+85512000001', '+85512000002'], emails: [] } });
    const owner = ctx.fake.token({ uid: 'owner', phone: '+85512000001' });
    const partner = ctx.fake.token({ uid: 'partner', phone: '+85512000002' });
    await request(ctx.app).post('/v1/auth/session').set(bearer(owner)).expect(200);
    const p = await request(ctx.app).post('/v1/auth/session').set(bearer(partner)).expect(200);
    const res = await request(ctx.app).patch(`/v1/admin/users/${p.body.user.id}/role`).set(bearer(owner)).send({ role: 'customer' }).expect(409);
    expect(res.body.error.code).toBe('bootstrap_admin');
  });
});

describe('default address', () => {
  it('keeps exactly one default when two are chosen at the same moment', async () => {
    const ctx = memberApp(database);
    const token = ctx.fake.token({ uid: 'two-defaults', phone: '+85512009994' });
    const address = await phnomPenhAddress(database);
    const a = await request(ctx.app).post('/v1/me/addresses').set(bearer(token)).send({ label: 'Home', ...address }).expect(201);
    const b = await request(ctx.app).post('/v1/me/addresses').set(bearer(token)).send({ label: 'Work', ...address }).expect(201);
    for (let i = 0; i < 5; i++) {
      await Promise.all([
        request(ctx.app).post(`/v1/me/addresses/${a.body.address.id}/default`).set(bearer(token)),
        request(ctx.app).post(`/v1/me/addresses/${b.body.address.id}/default`).set(bearer(token)),
      ]);
      expect((await q('select count(*)::int as n from addresses where is_default')).rows[0].n).toBe(1);
    }
  });
});
