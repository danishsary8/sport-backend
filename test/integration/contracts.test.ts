import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZodType } from 'zod';
import { account, catalog, commerce, common } from '../../src/contracts/index.js';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { bearer, memberApp } from '../helpers/app.js';
import { setProductStock, withCatalog } from '../helpers/catalog.js';
import { guestOrder, idem, JERSEY, payOrder, phnomPenhAddress, variantId } from '../helpers/checkout.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
let ctx: ReturnType<typeof memberApp>;
let token: string;
let number: string;
let guestToken: string;
let guestNumber: string;

function conforms(schema: ZodType, body: unknown) {
  const result = schema.safeParse(body);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues.slice(0, 5), null, 1));
  expect(result.success).toBe(true);
}

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
  await seed(database.db);
  await setProductStock(database, JERSEY, 10);
  ctx = memberApp(database);
  token = ctx.fake.token({ uid: 'contract-member', phone: '+85512009400', email: 'c@example.com', emailVerified: true, name: 'Contract' });
  const address = await phnomPenhAddress(database);
  conforms(account.addressResponse, (await request(ctx.app).post('/v1/me/addresses').set(bearer(token)).send({ label: 'Home', ...address }).expect(201)).body);
  const v = await variantId(database, JERSEY, 'M');
  const vl = await variantId(database, JERSEY, 'L');
  conforms(commerce.cartResponse, (await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: vl, qty: 2 }).expect(200)).body);
  const lineId = (await request(ctx.app).get('/v1/cart').set(bearer(token))).body.cart.lines[0].id;
  conforms(commerce.cartResponse, (await request(ctx.app).patch(`/v1/cart/items/${lineId}`).set(bearer(token)).send({ qty: 1 }).expect(200)).body);
  conforms(commerce.cartResponse, (await request(ctx.app).delete(`/v1/cart/items/${lineId}`).set(bearer(token)).expect(200)).body);
  await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: v, qty: 1, customPrint: { name: 'DARA', number: 10, patch: 'none' } }).expect(200);
  conforms(commerce.cartResponse, (await request(ctx.app).put('/v1/cart/promo').set(bearer(token)).send({ code: 'CASTLE10' }).expect(200)).body);
  const placed = await request(ctx.app).post('/v1/orders').set(bearer(token)).set(idem()).send(guestOrder(address)).expect(201);
  conforms(commerce.placedOrder, placed.body);
  number = placed.body.order.number;
  await payOrder(ctx.app, placed.body.payment.tranId);
  await request(ctx.app).put(`/v1/me/wishlist/${JERSEY}`).set(bearer(token)).expect(204);
  const guest = request.agent(ctx.app);
  await guest.post('/v1/cart/items').send({ variantId: v, qty: 1 }).expect(200);
  const g = await guest.post('/v1/orders').set(idem()).send(guestOrder(address, { paymentMethod: 'card' })).expect(201);
  conforms(commerce.placedOrder, g.body);
  guestToken = g.body.orderAccessToken;
  guestNumber = g.body.order.number;
});
afterAll(closeTestDb);

const pub: [string, string, () => ZodType][] = [
  ['product list', '/v1/catalog/products?pageSize=48', () => catalog.productList],
  ['filters', '/v1/catalog/filters?category=boots', () => catalog.filters],
  ['product detail', `/v1/catalog/products/${JERSEY}`, () => catalog.productDetailResponse],
  ['menu', '/v1/catalog/menu', () => catalog.menu],
  ['home', '/v1/catalog/home', () => catalog.home],
  ['search suggest', '/v1/search/suggest?q=nike', () => catalog.suggest],
  ['branches', '/v1/branches', () => catalog.branches],
  ['provinces', '/v1/geo/provinces', () => catalog.provinces],
  ['districts', '/v1/geo/districts?provinceCode=12', () => catalog.districts],
  ['questions', `/v1/catalog/products/${JERSEY}/questions`, () => catalog.questions],
];

describe('public responses match the contract', () => {
  for (const [name, path, schema] of pub) {
    it(name, async () => conforms(schema(), (await request(ctx.app).get(path).expect(200)).body));
  }
  it('collection', async () => {
    const slug = (await database.pool.query('select slug from collections limit 1')).rows[0].slug;
    conforms(catalog.collection, (await request(ctx.app).get(`/v1/catalog/collections/${slug}`).expect(200)).body);
  });
  it('communes', async () => {
    const d = (await database.pool.query("select code from geo_districts where province_code = '12' limit 1")).rows[0].code;
    conforms(catalog.communes, (await request(ctx.app).get(`/v1/geo/communes?districtCode=${d}`).expect(200)).body);
  });
  it('tracking', async () => {
    conforms(commerce.trackResponse, (await request(ctx.app).post('/v1/orders/track').send({ orderNumber: number, phone: '012345678' }).expect(200)).body);
  });
  it('guest order, status and payment switch', async () => {
    conforms(commerce.orderResponse, (await request(ctx.app).get(`/v1/orders/${guestNumber}`).set('x-order-token', guestToken).expect(200)).body);
    conforms(commerce.paymentStatus, (await request(ctx.app).get(`/v1/orders/${guestNumber}/payment-status`).set('x-order-token', guestToken).expect(200)).body);
    conforms(commerce.newPayment, (await request(ctx.app).post(`/v1/orders/${guestNumber}/payments`).send({ method: 'aba_khqr', contactPhone: '012345678', orderAccessToken: guestToken }).expect(201)).body);
  });
});

describe('member responses match the contract', () => {
  const m: [string, string, () => ZodType][] = [
    ['me', '/v1/me', () => account.me],
    ['addresses', '/v1/me/addresses', () => account.addresses],
    ['wishlist', '/v1/me/wishlist', () => account.wishlist],
    ['cart', '/v1/cart', () => commerce.cartResponse],
    ['my orders', '/v1/me/orders', () => commerce.myOrders],
    ['loyalty', '/v1/me/loyalty', () => account.loyalty],
    ['insights', '/v1/me/insights', () => account.insights],
    ['returns', '/v1/me/returns', () => account.returns],
  ];
  for (const [name, path, schema] of m) {
    it(name, async () => conforms(schema(), (await request(ctx.app).get(path).set(bearer(token)).expect(200)).body));
  }
  it('session', async () => conforms(account.session, (await request(ctx.app).post('/v1/auth/session').set(bearer(token)).expect(200)).body));
  it('my order', async () => conforms(commerce.orderResponse, (await request(ctx.app).get(`/v1/me/orders/${number}`).set(bearer(token)).expect(200)).body));
  it('a return request', async () => {
    await database.pool.query("update orders set status = 'delivered', delivered_at = now() where number = $1", [number]);
    const items = (await request(ctx.app).get(`/v1/me/orders/${number}`).set(bearer(token))).body.order.items;
    // The printed line can't be returned: the 400 answer is the contract's error body.
    const refused = await request(ctx.app).post('/v1/me/returns').set(bearer(token)).send({ orderNumber: number, resolution: 'refund', items: [{ orderItemId: items[0].id, qty: 1, reason: 'x' }] }).expect(400);
    conforms(common.errorBody, refused.body);
  });
  it('quote', async () => {
    const v = await variantId(database, JERSEY, 'L');
    await request(ctx.app).post('/v1/cart/items').set(bearer(token)).send({ variantId: v, qty: 1 }).expect(200);
    conforms(commerce.quote, (await request(ctx.app).post('/v1/checkout/quote').set(bearer(token)).send({ fulfillment: 'delivery', provinceCode: '12', shippingMethodId: 'pp_rider' }).expect(200)).body);
  });
});
