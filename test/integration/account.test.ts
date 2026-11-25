import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let token: string;

beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetDb(database);
  ctx = memberApp(database);
  token = ctx.fake.token({ uid: 'member-1', phone: '+85512345678' });
  await request(ctx.app).post('/v1/auth/session').set(bearer(token));
});

describe('PATCH /v1/me', () => {
  it('updates profile fields', async () => {
    const res = await request(ctx.app)
      .patch('/v1/me')
      .set(bearer(token))
      .send({ fullName: 'Sok Dara', preferredJerseySize: 'L', preferredBootSize: 'EU 42', homeBranchId: 'sensok' });
    expect(res.status).toBe(200);
    const me = await request(ctx.app).get('/v1/me').set(bearer(token));
    expect(me.body.user).toMatchObject({
      fullName: 'Sok Dara',
      preferredJerseySize: 'L',
      preferredBootSize: 'EU 42',
      homeBranchId: 'sensok',
    });
  });

  it('never lets a member change their role, phone or email', async () => {
    const onlyForbidden = await request(ctx.app).patch('/v1/me').set(bearer(token)).send({ role: 'admin' });
    expect(onlyForbidden.status).toBe(400);

    const mixed = await request(ctx.app)
      .patch('/v1/me')
      .set(bearer(token))
      .send({ fullName: 'X', role: 'admin', phone: '+85500000000', email: 'x@x.com' });
    expect(mixed.status).toBe(200);
    expect(mixed.body.user).toMatchObject({ role: 'customer', phone: '+85512345678', email: null });
  });

  it('rejects an unknown home branch', async () => {
    const res = await request(ctx.app).patch('/v1/me').set(bearer(token)).send({ homeBranchId: 'nowhere' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('homeBranchId');
  });

  it('rejects an unknown jersey size', async () => {
    const res = await request(ctx.app).patch('/v1/me').set(bearer(token)).send({ preferredJerseySize: 'XXXXL' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /v1/me', () => {
  it('anonymises the account, deletes the Firebase user and locks the token out', async () => {
    const res = await request(ctx.app).delete('/v1/me').set(bearer(token));
    expect(res.status).toBe(204);
    expect(ctx.fake.deleted).toEqual(['member-1']);

    const row = await database.pool.query("select phone_e164, email, full_name, deleted_at from users where firebase_uid = 'member-1'");
    expect(row.rows[0]).toMatchObject({ phone_e164: null, email: null, full_name: null });
    expect(row.rows[0]?.deleted_at).not.toBeNull();

    const me = await request(ctx.app).get('/v1/me').set(bearer(token));
    expect(me.status).toBe(403);
    expect(me.body.error.code).toBe('account_deleted');
  });

  it('still succeeds when Firebase deletion fails', async () => {
    ctx.fake.failDeletes();
    const res = await request(ctx.app).delete('/v1/me').set(bearer(token));
    expect(res.status).toBe(204);
  });
});
