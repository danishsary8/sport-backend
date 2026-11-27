import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { BakongProvider } from '../../src/modules/payments/bakong/client.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, phnomPenhAddress, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

/** Bakong's check API, answering "not found" until a payment is "made". */
let paid: { md5: string; amount: number } | null = null;
const asked: string[] = [];
const bakongApi = (async (_url: string, init: RequestInit) => {
  const { md5 } = JSON.parse(String(init.body)) as { md5: string };
  asked.push(md5);
  const body = paid?.md5 === md5 ? { responseCode: 0, data: { hash: 'h1', toAccountId: 'sportcastle@aba', currency: 'USD', amount: paid.amount } } : { responseCode: 1, data: null };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let token: string;

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  await setProductStock(database, JERSEY, 10);
  const provider = new BakongProvider({ token: 't', accountId: 'sportcastle@aba', merchantName: 'Sport Heaven', merchantCity: 'Phnom Penh', apiUrl: 'https://bakong.test' }, bakongApi);
  ctx = memberApp(database, undefined, { payments: provider });
  token = ctx.fake.token({ uid: 'bakong-member', phone: '+85512009500', email: 'b@example.com', emailVerified: true, name: 'Bakong Buyer' });
});
afterAll(closeTestDb);

describe('paying with Bakong KHQR', () => {
  it('offers KHQR (not card) for delivery, and confirms the order once Bakong reports it paid', async () => {
    const address = await phnomPenhAddress(database);
    await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: await variantId(database, JERSEY, 'M'), qty: 1 }).expect(200);

    const quote = await request(ctx.app).post('/v1/checkout/quote').set(bearer(token)).send({ fulfillment: 'delivery', address, shippingMethodId: 'pp_rider' }).expect(200);
    expect(quote.body.paymentMethods).toEqual(['aba_khqr']);

    await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(address, { paymentMethod: 'card' })).expect(400);
    const placed = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(address)).expect(201);
    const number = placed.body.order.number as string;
    const amountCents = placed.body.payment.amountCents as number;
    const qr = placed.body.payment.instructions.qrString as string;
    expect(qr).toContain('0015sportcastle@aba');

    const [row] = (await database.pool.query<{ raw: { md5: string } }>(`select p.raw from payments p join orders o on o.id = p.order_id where o.number = $1`, [number])).rows;
    const md5 = row!.raw.md5;

    const waiting = await request(ctx.app).get(`/v1/orders/${number}/payment-status`).set(bearer(token)).expect(200);
    expect(waiting.body).toMatchObject({ status: 'pending_payment', paymentStatus: 'unpaid' });
    expect(asked).toContain(md5);

    paid = { md5, amount: amountCents / 100 };
    await database.pool.query(`update payments set last_checked_at = null`); // skip the 5-second poll throttle
    const done = await request(ctx.app).get(`/v1/orders/${number}/payment-status`).set(bearer(token)).expect(200);
    expect(done.body).toMatchObject({ status: 'confirmed', paymentStatus: 'paid' });
    const [after] = (await database.pool.query<{ raw: { created: { md5: string } } }>(`select raw from payments where raw->'created'->>'md5' = $1`, [md5])).rows;
    expect(after).toBeTruthy(); // the QR's md5 is kept after confirmation
  });
});
