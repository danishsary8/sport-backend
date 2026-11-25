import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { FakeNotifier } from '../../src/modules/notifications/notifier.js';
import { render } from '../../src/modules/notifications/templates.js';
import { FakePaymentProvider } from '../../src/modules/payments/fake.js';
import { bearer, memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, setStockAt, staffToken, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
let admin: string;
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
  for (const t of ['carts', 'orders', 'idempotency_keys']) await q(`delete from ${t}`);
  await q("delete from promotions where code like 'T7%'");
  await setStockAt(database, jerseyM, { sonthormuk: 10, sensok: 10 });
  ctx = memberApp(database);
  admin = await staffToken(ctx.app, database, ctx.fake, 'leftover-admin', 'admin');
});

describe('promotion rules', () => {
  const create = (body: object) => request(ctx.app).post('/v1/admin/promotions').set(bearer(admin)).send({ name: 'Test', ...body });

  it('refuses an end date before the start date', async () => {
    const res = await create({ code: 'T7DATES', type: 'percent', value: 10, startsAt: '2026-12-10', endsAt: '2026-12-01' }).expect(400);
    expect(JSON.stringify(res.body)).toContain('endsAt');
  });

  it('keeps free delivery promos to value 0 and no product scope', async () => {
    await create({ code: 'T7FREE1', type: 'free_shipping', value: 100 }).expect(400);
    await create({ code: 'T7FREE2', type: 'free_shipping', value: 0, scope: { categories: ['boots'] } }).expect(400);
    await create({ code: 'T7FREE3', type: 'free_shipping', value: 0, scope: { methods: ['pp_rider'] } }).expect(201);
  });

  it('refuses delivery-method scope on money-off promos, also when patched', async () => {
    await create({ code: 'T7PCT', type: 'percent', value: 10, scope: { methods: ['pp_rider'] } }).expect(400);
    const ok = await create({ code: 'T7FIX', type: 'fixed', value: 500 }).expect(201);
    await request(ctx.app).patch(`/v1/admin/promotions/${ok.body.promotion.id}`).set(bearer(admin)).send({ scope: { methods: ['pickup'] } }).expect(400);
  });
});

describe('order placement leftovers', () => {
  it('reports sold-out lines with both the line and the variant', async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: jerseyM, qty: 3 }).expect(200);
    const cart = await agent.get('/v1/cart').expect(200);
    await setStockAt(database, jerseyM, { sonthormuk: 2 });
    const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(409);
    expect(res.body.error.code).toBe('stock_changed');
    expect(res.body.error.details.lines[0]).toEqual({ lineId: cart.body.cart.lines[0].id, variantId: jerseyM, available: 1 });
  });

  it('still answers 201 (with a payment error) when the payment service breaks unexpectedly', async () => {
    const payments = new FakePaymentProvider();
    payments.createTransaction = async () => {
      throw new TypeError('socket hang up');
    };
    ctx = memberApp(database, undefined, { payments });
    const agent = request.agent(ctx.app);
    await agent.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
    const res = await agent.post('/v1/orders').set(idem()).send(guestOrder(address)).expect(201);
    expect(res.body.payment).toBeNull();
    expect(res.body.paymentError).toBeTruthy();
    expect(res.body.orderAccessToken).toBeTruthy();
  });

  it('forgets idempotency keys after 24 hours', async () => {
    await q("insert into idempotency_keys (key, scope, request_hash, status_code, response, created_at) values ('old', 's', 'h', 201, '{}', now() - interval '25 hours'), ('new', 's', 'h', 201, '{}', now())");
    await sweepOnce({
      database,
      payments: ctx.payments,
      notifiers: { telegram: new FakeNotifier('telegram'), email: new FakeNotifier('email') },
      logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
      now: () => new Date(),
    });
    expect((await q('select key from idempotency_keys')).rows).toEqual([{ key: 'new' }]);
  });
});

describe('refund alerts', () => {
  it('headline the amount actually paid when it differs from the order', () => {
    const m = render('needs_refund', { number: 'SC-2611-AAAAA', status: 'pending_payment', totalCents: 5250, totalKhr: 0, contactName: 'A', contactPhone: '+855', contactChannel: 'phone', fulfillment: 'delivery', items: [], reason: 'amount mismatch', paidCents: 100 }, 'telegram');
    expect(m.text.split('\n')[0]).toContain('$1.00');
  });
});
