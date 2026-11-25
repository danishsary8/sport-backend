import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
const tokens = { admin: '', staff: '', customer: '' };
let customerId: string;
let adminId: string;

beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);

beforeEach(async () => {
  await resetDb(database);
  ctx = memberApp(database);
  tokens.admin = ctx.fake.token({ uid: 'admin', phone: '+85511111111', name: 'Owner' });
  tokens.staff = ctx.fake.token({ uid: 'staff', phone: '+85522222222' });
  tokens.customer = ctx.fake.token({ uid: 'cust', phone: '+85512345678', name: 'Sok Dara' });
  for (const t of Object.values(tokens)) await request(ctx.app).post('/v1/auth/session').set(bearer(t));
  await database.pool.query("update users set role = 'admin' where firebase_uid = 'admin'");
  await database.pool.query("update users set role = 'staff' where firebase_uid = 'staff'");
  customerId = (await database.pool.query("select id from users where firebase_uid = 'cust'")).rows[0].id;
  adminId = (await database.pool.query("select id from users where firebase_uid = 'admin'")).rows[0].id;
});

const listUsers = (token: string, query = '') => request(ctx.app).get(`/v1/admin/users${query}`).set(bearer(token));
const setRole = (token: string, id: string, body: object) =>
  request(ctx.app).patch(`/v1/admin/users/${id}/role`).set(bearer(token)).send(body);

describe('admin access', () => {
  it('is forbidden to customers and staff', async () => {
    for (const t of [tokens.customer, tokens.staff]) {
      const res = await listUsers(t);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
  });
});

describe('GET /v1/admin/users', () => {
  it('lists users with paging info', async () => {
    const res = await listUsers(tokens.admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 20 });
  });

  it('searches by phone digits and name', async () => {
    const byPhone = await listUsers(tokens.admin, '?q=345678');
    expect(byPhone.body.users.map((u: { id: string }) => u.id)).toEqual([customerId]);
    const byName = await listUsers(tokens.admin, '?q=dara');
    expect(byName.body.users.map((u: { id: string }) => u.id)).toEqual([customerId]);
  });

  it('filters by role and hides deleted users', async () => {
    expect((await listUsers(tokens.admin, '?role=staff')).body.total).toBe(1);
    await database.pool.query("update users set deleted_at = now() where firebase_uid = 'cust'");
    expect((await listUsers(tokens.admin)).body.total).toBe(2);
  });

  it('caps the page size', async () => {
    expect((await listUsers(tokens.admin, '?pageSize=500')).status).toBe(400);
  });
});

describe('PATCH /v1/admin/users/:id/role', () => {
  it('makes a customer staff at a branch, and back', async () => {
    const promoted = await setRole(tokens.admin, customerId, { role: 'staff', staffBranchId: 'sensok' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.user).toMatchObject({ role: 'staff', staffBranchId: 'sensok' });

    const demoted = await setRole(tokens.admin, customerId, { role: 'customer' });
    expect(demoted.body.user).toMatchObject({ role: 'customer', staffBranchId: null });
  });

  it('only allows a branch for staff', async () => {
    const res = await setRole(tokens.admin, customerId, { role: 'admin', staffBranchId: 'sensok' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown branch', async () => {
    const res = await setRole(tokens.admin, customerId, { role: 'staff', staffBranchId: 'nowhere' });
    expect(res.status).toBe(400);
  });

  it('stops admins changing their own role', async () => {
    const res = await setRole(tokens.admin, adminId, { role: 'customer' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('cannot_change_own_role');
  });

  it('answers 404 for unknown users', async () => {
    expect((await setRole(tokens.admin, '00000000-0000-0000-0000-000000000000', { role: 'staff' })).status).toBe(404);
    expect((await setRole(tokens.admin, 'nope', { role: 'staff' })).status).toBe(404);
  });
});
