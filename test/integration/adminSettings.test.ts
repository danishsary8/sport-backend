import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let admin: string;
let staff: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const KEYS = ['payment_methods_enabled', 'reservation_minutes', 'cash_on_pickup_hours', 'online_safety_buffer', 'return_rules', 'size_guides'];

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  ctx = memberApp(database);
  admin = ctx.fake.token({ uid: 'settings-admin', phone: '+85511110001' });
  staff = ctx.fake.token({ uid: 'settings-staff', phone: '+85511110002' });
  for (const t of [admin, staff]) await request(ctx.app).post('/v1/auth/session').set(bearer(t));
  await q("update users set role = 'admin' where firebase_uid = 'settings-admin'");
  await q("update users set role = 'staff' where firebase_uid = 'settings-staff'");
});
afterAll(async () => {
  await q(`delete from settings where key = any($1)`, [KEYS]);
  await seed(database.db);
  await closeTestDb();
});

const api = (method: 'get' | 'put', path: string, token: string, body?: object) => {
  const r = request(ctx.app)[method](`/v1/admin${path}`).set(bearer(token));
  return body ? r.send(body) : r;
};

describe('admin operational settings', () => {
  it('lists every operational setting for admins only', async () => {
    expect((await api('get', '/settings', staff)).status).toBe(403);
    const res = await api('get', '/settings', admin).expect(200);
    expect(Object.keys(res.body.settings).sort()).toEqual([...KEYS].sort());
    expect(res.body.settings.reservation_minutes).toEqual({ minutes: 30 });
  });

  it('switches payment methods on and off, and the quote follows', async () => {
    await api('put', '/settings/payment_methods_enabled', admin, { aba_khqr: true, card: false, acleda: false, wing: false, cash_on_pickup: true }).expect(200);
    const quote = await request(ctx.app).post('/v1/checkout/quote').send({ fulfillment: 'pickup', pickupBranchId: 'sonthormuk' }).expect(200);
    expect(quote.body.paymentMethods).toEqual(['aba_khqr', 'cash_on_pickup']);
    expect((await api('put', '/settings/payment_methods_enabled', admin, { aba_khqr: true })).status).toBe(400);
    await api('put', '/settings/payment_methods_enabled', admin, { aba_khqr: true, card: true, acleda: false, wing: false, cash_on_pickup: false }).expect(200);
  });

  it('validates each setting', async () => {
    expect((await api('put', '/settings/reservation_minutes', admin, { minutes: 2 })).status).toBe(400);
    expect((await api('put', '/settings/cash_on_pickup_hours', admin, { hours: 0 })).status).toBe(400);
    expect((await api('put', '/settings/online_safety_buffer', admin, { units: -1 })).status).toBe(400);
    expect((await api('put', '/settings/return_rules', admin, { exchangeDays: 5, refundDays: 10, nonReturnable: [] })).status).toBe(400);
    expect((await api('put', '/settings/size_guides', admin, { boots: { title: { en: 'x' }, columns: ['EU'], rows: [['38', 'extra']], note: null } })).status).toBe(400);
    expect((await api('put', '/settings/khr_rate', admin, { rate: 1 })).status).toBe(404);
    await api('put', '/settings/reservation_minutes', admin, { minutes: 45 }).expect(200);
    expect((await q("select value from settings where key = 'reservation_minutes'")).rows[0].value).toEqual({ minutes: 45 });
    await api('put', '/settings/return_rules', admin, { exchangeDays: 30, refundDays: 7, nonReturnable: ['socks'] }).expect(200);
  });
});
