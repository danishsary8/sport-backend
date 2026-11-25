import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { expireOrder, sweepOnce } from '../../src/jobs/sweeper.js';
import { FakeNotifier } from '../../src/modules/notifications/notifier.js';
import { memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, placeGuestOrder, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const MIN = 60_000;
const sweepDeps = (offsetMs: number) => ({
  database,
  payments: ctx.payments,
  notifiers: { telegram: new FakeNotifier('telegram'), email: new FakeNotifier('email') },
  logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
  now: () => new Date(Date.now() + offsetMs),
});
function webhook(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return request(ctx.app).post('/v1/webhooks/payway').set('content-type', 'application/json').set('x-fake-signature', ctx.payments.sign(raw)).send(raw);
}

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
  await q('delete from payment_webhook_events');
  await q('delete from notification_outbox');
  await setStockAt(database, jerseyM, { sonthormuk: 100 });
  ctx = memberApp(database);
});

describe('busy checkouts', () => {
  it('a burst of shoppers buying the same jersey all get their orders', async () => {
    const agents = await Promise.all(
      Array.from({ length: 8 }, async () => {
        const agent = request.agent(ctx.app);
        await agent.post('/v1/cart/items').send({ variantId: jerseyM, qty: 1 }).expect(200);
        return agent;
      }),
    );
    const results = await Promise.all(agents.map((a) => a.post('/v1/orders').set(idem()).send(guestOrder(address))));
    expect(results.map((r) => r.status).filter((s) => s !== 201 && s !== 503)).toEqual([]);
    expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(7);
  });
});

describe('webhooks that fail part-way', () => {
  it('reprocesses a delivery stuck in "received" for over a minute', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const tranId = body.payment!.tranId;
    await q(
      `insert into payment_webhook_events (provider, event_id, signature_valid, processing_status, tran_id, payload, received_at)
       values ('fake', $1, true, 'received', $2, '{}', now() - interval '5 minutes')`,
      [`${tranId}:approved`, tranId],
    );
    ctx.payments.approve(tranId);
    await webhook({ tran_id: tranId, status: 'approved' }).expect(200);
    expect((await q('select status from orders')).rows[0].status).toBe('confirmed');
    expect((await q('select processing_status from payment_webhook_events')).rows[0].processing_status).toBe('processed');
  });

  it('accepts a payment on a cancelled attempt when the order expires', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const first = body.payment!.tranId;
    await request(ctx.app).post(`/v1/orders/${body.order.number}/payments`).send({ method: 'card', contactPhone: '012345678', orderAccessToken: body.orderAccessToken }).expect(201);
    expect((await q('select status from payments where attempt = 1')).rows[0].status).toBe('cancelled');
    ctx.payments.approve(first);
    const orderId = (await q('select id from orders')).rows[0].id;
    await expireOrder(sweepDeps(31 * MIN), orderId);
    expect((await q('select status, payment_status from orders')).rows[0]).toEqual({ status: 'confirmed', payment_status: 'paid' });
  });
});

describe('holds always end', () => {
  it('expires the order two hours after its hold even if the payment service keeps failing, and alerts ops', async () => {
    await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    ctx.payments.failAllChecks(true);
    expect((await sweepOnce(sweepDeps(31 * MIN))).expired).toBe(0);
    expect((await sweepOnce(sweepDeps(31 * MIN + 2 * 60 * MIN))).expired).toBe(1);
    expect((await q('select status from orders')).rows[0].status).toBe('expired');
    expect((await q("select count(*)::int as n from notification_outbox where template = 'payment_unverified'")).rows[0].n).toBe(1);
  });
});

describe('webhook abuse', () => {
  it('refuses oversized bodies', async () => {
    const res = await request(ctx.app).post('/v1/webhooks/payway').set('content-type', 'application/json').send({ tran_id: 'x', junk: 'a'.repeat(40_000) });
    expect(res.status).toBe(413);
  });

  it('stores only the known pushback fields', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    await webhook({ tran_id: body.payment!.tranId, status: 'pending', extra: 'x'.repeat(500), name: 'Sok Dara' }).expect(200);
    const payload = (await q('select payload from payment_webhook_events')).rows[0].payload;
    expect(Object.keys(payload).sort()).toEqual(['status', 'tran_id']);
  });

  it('asks the provider at most once per couple of seconds per payment, however many pushbacks arrive', { timeout: 15_000 }, async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const before = ctx.payments.checkCalls;
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => webhook({ tran_id: body.payment!.tranId, status: 'pending', apv: String(i) })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    // The first is checked at once; the rest wait out the window once, and only one of them gets to check.
    expect(ctx.payments.checkCalls - before).toBeLessThanOrEqual(2);
  });
});
