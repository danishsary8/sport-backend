import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { InMemoryRateLimitStore } from '../../src/middleware/rateLimit.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  jerseyM = await variantId(database, JERSEY, 'M');
});
afterAll(closeTestDb);
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await setStockAt(database, jerseyM, { sonthormuk: 100 });
});

// Empty bags answer 400 quickly, which is enough to exercise the limiter in front of the handler.
describe('order limits', () => {
  it('lets one address place 10 orders a minute', async () => {
    const { app } = memberApp(database, undefined, { routeLimits: true });
    for (let i = 0; i < 10; i++) await request(app).post('/v1/orders').set('X-Forwarded-For', '203.0.113.7').set(idem()).send(guestOrder(address)).expect(400);
    const res = await request(app).post('/v1/orders').set('X-Forwarded-For', '203.0.113.7').set(idem()).send(guestOrder(address)).expect(429);
    expect(res.headers['retry-after']).toBeTruthy();
    expect(res.body.error.code).toBe('rate_limited');
    await request(app).post('/v1/orders').set('X-Forwarded-For', '198.51.100.9').set(idem()).send(guestOrder(address)).expect(400);
  });

  it('lets one member place 5 orders a minute, whatever address they use', async () => {
    const ctx = memberApp(database, undefined, { routeLimits: true });
    const token = ctx.fake.token({ uid: 'limit-member', phone: '+85512009300' });
    for (let i = 0; i < 5; i++) {
      await request(ctx.app).post('/v1/orders').set(bearer(token)).set('X-Forwarded-For', `203.0.113.${i}`).set(idem()).send(guestOrder(address)).expect(400);
    }
    await request(ctx.app).post('/v1/orders').set(bearer(token)).set('X-Forwarded-For', '203.0.113.99').set(idem()).send(guestOrder(address)).expect(429);
  });
});

describe('sign-in limit', () => {
  it('allows 20 session calls a minute per address', async () => {
    const ctx = memberApp(database, undefined, { routeLimits: true });
    const token = ctx.fake.token({ uid: 'limit-session', phone: '+85512009301' });
    for (let i = 0; i < 20; i++) await request(ctx.app).post('/v1/auth/session').set(bearer(token)).set('X-Forwarded-For', '203.0.113.50').expect(200);
    await request(ctx.app).post('/v1/auth/session').set(bearer(token)).set('X-Forwarded-For', '203.0.113.50').expect(429);
  });
});

describe('pluggable store', () => {
  it('uses the store the app is given', async () => {
    const store = new InMemoryRateLimitStore();
    const { app } = memberApp(database, undefined, { routeLimits: true, rateLimitStore: store });
    await request(app).post('/v1/orders/track').send({ orderNumber: 'SC-2611-AAAAA', phone: '012345678' }).expect(404);
    expect(store.size()).toBeGreaterThan(0);
  });
});
