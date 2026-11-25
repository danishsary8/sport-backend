/**
 * Load test of the order path: 50 shoppers check out the same jersey size at once while only 10 units are
 * sellable online. Expect exactly 10 orders, 40 "sold out" answers and no server errors.
 *
 *   npm run loadtest            (uses TEST_DATABASE_URL / sport_test, which it resets)
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { FakePaymentProvider } from '../src/modules/payments/fake.js';
import { createUnconfiguredIdentity } from '../src/lib/identity.js';
import { withCatalog } from '../test/helpers/catalog.js';
import { guestOrder, JERSEY, phnomPenhAddress, setStockAt, variantId } from '../test/helpers/checkout.js';
import { closeTestDb, testDb } from '../test/helpers/db.js';
import { testConfig } from '../test/helpers/testConfig.js';

const SHOPPERS = 50;
const SELLABLE = 10;

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function main(): Promise<void> {
  const database = await testDb();
  await withCatalog(database);
  const address = await phnomPenhAddress(database);
  const variant = await variantId(database, JERSEY, 'M');
  // Buffer 1 → SELLABLE + 1 on hand at one store.
  await setStockAt(database, variant, { sonthormuk: SELLABLE + 1 });

  const app = createApp({
    config: testConfig(),
    logger: createLogger({ logLevel: 'fatal', nodeEnv: 'test' }),
    db: database,
    identity: createUnconfiguredIdentity(),
    rateLimit: { enabled: false, routes: false },
    payments: new FakePaymentProvider(),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // One guest bag per shopper.
  const cookies: string[] = [];
  for (let i = 0; i < SHOPPERS; i++) {
    const res = await fetch(`${base}/v1/cart/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variantId: variant, qty: 1 }) });
    cookies.push((res.headers.get('set-cookie') ?? '').split(';')[0]!);
  }

  const body = JSON.stringify(guestOrder(address));
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let retries = 0;
  const started = performance.now();
  await Promise.all(
    cookies.map(async (cookie) => {
      const key = randomUUID();
      for (let attempt = 1; attempt <= 4; attempt++) {
        const t = performance.now();
        const res = await fetch(`${base}/v1/orders`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'idempotency-key': key }, body });
        latencies.push(performance.now() - t);
        const json = (await res.json()) as { error?: { code: string } };
        if (res.status === 503 && json.error?.code === 'busy' && attempt < 4) {
          retries += 1;
          continue;
        }
        const label = res.status === 201 ? '201' : `${res.status} ${json.error?.code ?? ''}`.trim();
        statuses[label] = (statuses[label] ?? 0) + 1;
        return;
      }
    }),
  );
  const wall = performance.now() - started;
  server.close();
  const stock = (await database.pool.query("select on_hand, reserved from stock where variant_id = $1 and branch_id = 'sonthormuk'", [variant])).rows[0];
  await closeTestDb();

  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    shoppers: SHOPPERS,
    sellable: SELLABLE,
    statuses,
    busyRetries: retries,
    stock,
    wallMs: Math.round(wall),
    latencyMs: { p50: Math.round(pct(sorted, 50)), p95: Math.round(pct(sorted, 95)), p99: Math.round(pct(sorted, 99)), max: Math.round(sorted.at(-1)!) },
  };
  console.log(JSON.stringify(report, null, 2));
  const ok = statuses['201'] === SELLABLE && statuses['409 stock_changed'] === SHOPPERS - SELLABLE && Object.keys(statuses).length === 2 && stock.reserved === SELLABLE;
  if (!ok) {
    console.error('LOAD TEST FAILED');
    process.exit(1);
  }
  console.log('LOAD TEST PASSED');
}

void main();
