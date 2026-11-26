import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { FakeNotifier } from '../../src/modules/notifications/notifier.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, setStockAt, staffToken, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const sweepDeps = () => ({
  database,
  payments: ctx.payments,
  notifiers: { telegram: new FakeNotifier('telegram'), email: new FakeNotifier('email') },
  logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
  now: () => new Date(),
});

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  jerseyM = await variantId(database, JERSEY, 'M');
});
afterAll(closeTestDb);
beforeEach(async () => {
  for (const t of ['carts', 'orders', 'payment_webhook_events']) await q(`delete from ${t}`);
  await q("update promotions set used_count = 0, max_uses_per_user = null where code = 'CASTLE10'");
  await setStockAt(database, jerseyM, { sonthormuk: 50 });
  ctx = memberApp(database);
});

describe('staff cancel racing a new order with the same promo', () => {
  it('never deadlocks', async () => {
    const admin = await staffToken(ctx.app, database, ctx.fake, 'p7-admin', 'admin');
    for (let round = 0; round < 6; round++) {
      // Keep this shopper under the open-unpaid-order cap: earlier rounds' orders count as abandoned.
      await q("update orders set status = 'expired' where status = 'pending_payment'");
      const first = request.agent(ctx.app);
      await first.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
      await first.put('/v1/cart/promo').send({ code: 'CASTLE10' }).expect(200);
      const placed = await first.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
      const second = request.agent(ctx.app);
      await second.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
      await second.put('/v1/cart/promo').send({ code: 'CASTLE10' }).expect(200);
      const [cancel, order] = await Promise.all([
        request(ctx.app).post(`/v1/admin/orders/${placed.body.order.number}/cancel`).set(bearer(admin)).send({ reason: 'race' }),
        second.post('/v1/orders').set(idem()).send(guestOrder(address)),
      ]);
      expect(cancel.status).toBe(200);
      expect(order.status).toBe(201);
    }
  });
});

describe('payment webhook abuse', () => {
  it('rejects absurdly long fields', async () => {
    const raw = JSON.stringify({ tran_id: 'x'.repeat(30), status: 'approved' });
    const res = await request(ctx.app).post('/v1/webhooks/payway').set('content-type', 'application/json').set('x-fake-signature', ctx.payments.sign(raw)).send(raw);
    expect(res.status).toBe(401);
    const long = JSON.stringify({ tran_id: 'SC2611AAAAA-1', status: 'approved', apv: 'y'.repeat(500) });
    const res2 = await request(ctx.app).post('/v1/webhooks/payway').set('content-type', 'application/json').set('x-fake-signature', ctx.payments.sign(long)).send(long);
    expect(res2.status).toBe(401);
  });

  it('limits one address to 60 pushbacks a minute', async () => {
    const limited = memberApp(database, undefined, { routeLimits: true });
    for (let i = 0; i < 60; i++) await request(limited.app).post('/v1/webhooks/payway').set('content-type', 'application/json').send({ tran_id: 'SC2611ZZZZZ-1', status: 'x' });
    await request(limited.app).post('/v1/webhooks/payway').set('content-type', 'application/json').send({ tran_id: 'SC2611ZZZZZ-1', status: 'x' }).expect(429);
  });

  it('forgets processed pushbacks after 90 days', async () => {
    await q(`insert into payment_webhook_events (provider, event_id, signature_valid, processing_status, payload, received_at)
      values ('fake', 'old', true, 'processed', '{}', now() - interval '91 days'), ('fake', 'new', true, 'processed', '{}', now())`);
    await sweepOnce(sweepDeps());
    expect((await q('select event_id from payment_webhook_events')).rows).toEqual([{ event_id: 'new' }]);
  });
});

describe('background job lock', () => {
  it('drops a connection whose unlock failed, so the lock cannot stay held', async () => {
    const realConnect = database.pool.connect.bind(database.pool);
    let destroyed = false;
    const spy = vi.spyOn(database.pool, 'connect').mockImplementationOnce((async () => {
      const client = await realConnect();
      const query = client.query.bind(client);
      const release = client.release.bind(client);
      (client as unknown as { query: unknown }).query = (text: unknown, values?: unknown) =>
        typeof text === 'string' && text.includes('pg_advisory_unlock') ? Promise.reject(new Error('statement timeout')) : query(text as string, values as unknown[]);
      (client as unknown as { release: unknown }).release = (err?: unknown) => {
        destroyed = err !== undefined && err !== false;
        return release(err as boolean);
      };
      return client;
    }) as never);
    try {
      await sweepOnce(sweepDeps());
    } finally {
      spy.mockRestore();
    }
    expect(destroyed).toBe(true);
    const next = await sweepOnce(sweepDeps());
    expect(next.locked).toBe(true);
  });
});

describe('deployment settings', () => {
  it('lets the proxy hop count be configured', () => {
    const base = { DATABASE_URL: 'postgres://x', COOKIE_SECRET: 'a'.repeat(32) };
    expect(loadConfig(base).trustProxyHops).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
  });
});

describe('OpenAPI', () => {
  it('lists every endpoint the storefront needs', () => {
    const doc = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const has = (method: string, path: string) => Boolean(doc.paths[path]?.[method]);
    for (const [method, path] of [
      ['patch', '/v1/me'],
      ['delete', '/v1/me'],
      ['delete', '/v1/me/addresses/{id}'],
      ['post', '/v1/me/addresses/{id}/default'],
      ['delete', '/v1/cart/items/{id}'],
      ['delete', '/v1/cart/promo'],
      ['put', '/v1/me/wishlist/{product}'],
      ['delete', '/v1/me/wishlist/{product}'],
      ['get', '/v1/search'],
    ] as const) {
      expect(has(method, path), `${method} ${path}`).toBe(true);
    }
  });
});
