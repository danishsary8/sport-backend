import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { startScheduler, sweepOnce, type SweepDeps } from '../../src/jobs/sweeper.js';
import { FakeNotifier } from '../../src/modules/notifications/notifier.js';
import { memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { JERSEY, PAYMENTS_DEFAULT, phnomPenhAddress, placeGuestOrder, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let address: Awaited<ReturnType<typeof phnomPenhAddress>>;
let jerseyM: string;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);
const MIN = 60_000;

function deps(offsetMs = 0): SweepDeps {
  return {
    database,
    payments: ctx.payments,
    notifiers: { telegram: new FakeNotifier('telegram'), email: new FakeNotifier('email') },
    logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    now: () => new Date(Date.now() + offsetMs),
  };
}
const reservedTotal = async () => (await q('select sum(reserved)::int as n from stock where variant_id = $1', [jerseyM])).rows[0].n;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  address = await phnomPenhAddress(database);
  jerseyM = await variantId(database, JERSEY, 'M');
});
afterAll(async () => {
  await q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(PAYMENTS_DEFAULT)]);
  await closeTestDb();
});
beforeEach(async () => {
  await q('delete from carts');
  await q('delete from orders');
  await q('delete from notification_outbox');
  await q("update promotions set used_count = 0 where code = 'CASTLE10'");
  await setProductStock(database, JERSEY, 10);
  ctx = memberApp(database);
});

describe('sweepOnce', () => {
  it('expires an unpaid order after its hold, releasing stock and the promo use', async () => {
    const { agent } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 }).then(async (r) => r);
    void agent;
    await q("update orders set promotion_id = (select id from promotions where code = 'CASTLE10')");
    await q("update promotions set used_count = 1 where code = 'CASTLE10'");
    const tranId = (await q('select provider_tran_id from payments')).rows[0].provider_tran_id;
    expect(await reservedTotal()).toBe(1);

    const result = await sweepOnce(deps(31 * MIN));
    expect(result.expired).toBe(1);
    expect((await q('select status from orders')).rows[0].status).toBe('expired');
    expect(await reservedTotal()).toBe(0);
    expect((await q("select count(*)::int as n from stock_movements where reason = 'order_release'")).rows[0].n).toBeGreaterThan(0);
    expect(ctx.payments.cancelled).toContain(tranId);
    expect((await q("select used_count from promotions where code = 'CASTLE10'")).rows[0].used_count).toBe(0);
    expect((await q("select status from payments")).rows[0].status).toBe('expired');
    expect((await q("select count(*)::int as n from notification_outbox where template = 'status_changed'")).rows[0].n).toBe(1);
  });

  it('confirms an order the provider has approved instead of expiring it', async () => {
    const { body } = await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    ctx.payments.approve(body.payment!.tranId);
    // A poll a moment ago means the throttled check would skip this payment.
    await q('update payments set last_checked_at = now()');
    const result = await sweepOnce(deps(31 * MIN));
    expect(result.expired).toBe(0);
    expect((await q('select status, payment_status from orders')).rows[0]).toEqual({ status: 'confirmed', payment_status: 'paid' });
  });

  it('leaves orders still inside their hold alone', async () => {
    await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    expect((await sweepOnce(deps(5 * MIN))).expired).toBe(0);
    expect((await q('select status from orders')).rows[0].status).toBe('pending_payment');
  });

  it('does nothing while another instance holds the job lock', async () => {
    await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const other = await database.pool.connect();
    try {
      await other.query('select pg_advisory_lock(727001)');
      const result = await sweepOnce(deps(31 * MIN));
      expect(result).toMatchObject({ locked: false, expired: 0 });
      expect((await q('select status from orders')).rows[0].status).toBe('pending_payment');
    } finally {
      await other.query('select pg_advisory_unlock(727001)');
      other.release();
    }
  });

  it('deletes guest bags untouched for 60 days, keeping newer ones and member bags', async () => {
    await q("insert into carts (guest_token, updated_at) values ('old', now() - interval '61 days'), ('new', now() - interval '59 days')");
    await q("insert into users (firebase_uid, full_name) values ('cart-member', 'M') on conflict do nothing");
    await q("insert into carts (user_id, updated_at) select id, now() - interval '400 days' from users where firebase_uid = 'cart-member'");
    const result = await sweepOnce(deps());
    expect(result.guestCartsDeleted).toBe(1);
    expect((await q('select guest_token from carts where guest_token is not null')).rows).toEqual([{ guest_token: 'new' }]);
    expect((await q('select count(*)::int as n from carts where user_id is not null')).rows[0].n).toBe(1);
  });

  it('expires a cash-on-pickup order after 48 hours', async () => {
    await q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify({ ...PAYMENTS_DEFAULT, cash_on_pickup: true })]);
    await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 }, { fulfillment: 'pickup', pickupBranchId: 'sonthormuk', address: undefined, shippingMethodId: undefined, paymentMethod: 'cash_on_pickup' });
    await q("update settings set value = $1 where key = 'payment_methods_enabled'", [JSON.stringify(PAYMENTS_DEFAULT)]);
    expect((await sweepOnce(deps(47 * 60 * MIN))).expired).toBe(0);
    expect((await sweepOnce(deps(49 * 60 * MIN))).expired).toBe(1);
    expect(await reservedTotal()).toBe(0);
  });

  it('sends queued notifications', async () => {
    await placeGuestOrder(ctx.app, address, { variantId: jerseyM, qty: 1 });
    const d = deps();
    const result = await sweepOnce(d);
    expect(result.notifications.sent).toBe(1);
    expect((d.notifiers.telegram as FakeNotifier).sent).toHaveLength(1);
  });
});

describe('startScheduler', () => {
  it('stops cleanly while a run is in progress', async () => {
    const scheduler = startScheduler({ ...deps(), intervalMs: 60_000 });
    const running = scheduler.runNow();
    await scheduler.stop();
    await running;
  });
});
