import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { startScheduler, sweepOnce } from '../../src/jobs/sweeper.js';
import { FakeNotifier } from '../../src/modules/notifications/notifier.js';
import { applyProviderResult } from '../../src/modules/payments/confirm.js';
import { memberApp } from '../helpers/app.js';
import { withCatalog } from '../helpers/catalog.js';
import { JERSEY, phnomPenhAddress, placeGuestOrder, setStockAt, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const MIN = 60_000;
const deps = (offsetMs = 0, telegram = new FakeNotifier('telegram')) => ({
  database,
  payments: ctx.payments,
  notifiers: { telegram, email: new FakeNotifier('email') },
  logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
  now: () => new Date(Date.now() + offsetMs),
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
  for (const t of ['carts', 'orders', 'notification_outbox']) await q(`delete from ${t}`);
  await setStockAt(database, jerseyM, { sonthormuk: 20 });
  ctx = memberApp(database);
});

describe('two payment attempts approved at once', () => {
  it('confirms once and flags the other for a refund, without a deadlock', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    // A second attempt while the first is still pending (as during a slow provider call).
    const orderId = (await q('select id from orders')).rows[0].id;
    await q(`insert into payments (order_id, attempt, provider, provider_tran_id, method, amount_cents, status) values ($1, 2, 'fake', 'SC2611XXXXX-2', 'card', $2, 'pending')`, [orderId, body.order.pricing.totalCents]);
    const check = { status: 'approved' as const, amountCents: body.order.pricing.totalCents, raw: null };
    for (let i = 0; i < 3; i++) {
      await q("update payments set status = 'pending'");
      await q("update orders set status = 'pending_payment', payment_status = 'unpaid', needs_refund = false");
      await q('update stock set on_hand = 20, reserved = 1 where variant_id = $1 and branch_id = $2', [jerseyM, 'sonthormuk']);
      const results = await Promise.all([
        applyProviderResult({ db: database.db, now: () => new Date() }, body.payment!.tranId, check, 'webhook'),
        applyProviderResult({ db: database.db, now: () => new Date() }, 'SC2611XXXXX-2', check, 'webhook'),
      ]);
      expect(results.sort()).toEqual(['approved', 'needs_refund']);
    }
  });
});

describe('sweeper during a payment service outage', () => {
  it('still sends notifications and asks the provider only once', async () => {
    for (let i = 0; i < 3; i++) await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    ctx.payments.failAllChecks(true);
    const before = ctx.payments.checkCalls;
    const telegram = new FakeNotifier('telegram');
    const result = await sweepOnce(deps(31 * MIN, telegram));
    expect(ctx.payments.checkCalls - before).toBe(1);
    expect(result.notifications.sent).toBe(3);
    expect(telegram.sent).toHaveLength(3);
  });

  it('stops quickly even while a provider call hangs', async () => {
    for (let i = 0; i < 3; i++) await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    let release: () => void = () => {};
    ctx.payments.checkTransaction = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 'pending', amountCents: null, raw: null });
      });
    const scheduler = startScheduler({ ...deps(31 * MIN), intervalMs: 60_000 });
    const run = scheduler.runNow();
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    await scheduler.stop();
    expect(Date.now() - started).toBeLessThan(2_000);
    // Let the hung call finish (as a real timeout would) so the run releases its database connection.
    release();
    await run;
  });
});
