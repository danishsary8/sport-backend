/**
 * Builds docs/api/openapi.json (OpenAPI 3.1) from the Zod contracts in src/contracts.
 *   npm run contracts:openapi
 * CI fails when the committed file is out of date.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { z, type ZodType } from 'zod';
import { profilePatchSchema } from '../src/modules/account/service.js';
import { account, catalog, commerce, common, addressCreateSchema, addressPatchSchema, catalogQuerySchema, placeOrderSchema, quoteSchema, rmaCreateSchema, customPrintSchema } from '../src/contracts/index.js';

type Auth = 'public' | 'member' | 'guest-or-member' | 'order-owner';
interface Route {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  auth: Auth;
  query?: ZodType;
  body?: ZodType;
  response?: ZodType;
  status?: number;
  headers?: { name: string; required: boolean; description: string }[];
}

const idemHeader = { name: 'Idempotency-Key', required: true, description: 'A UUID per checkout attempt; a replay returns the same order.' };
const orderToken = { name: 'X-Order-Token', required: false, description: "A guest's orderAccessToken (members send their bearer token instead)." };

const ROUTES: Route[] = [
  { method: 'get', path: '/v1/catalog/products', summary: 'Product listing (repeat a param for OR)', auth: 'public', query: catalogQuerySchema, response: catalog.productList },
  { method: 'get', path: '/v1/catalog/filters', summary: 'Facets with counts for the current filters', auth: 'public', query: catalogQuerySchema, response: catalog.filters },
  { method: 'get', path: '/v1/catalog/products/{slug}', summary: 'Product detail with sizes, availability per branch and related products', auth: 'public', response: catalog.productDetailResponse },
  { method: 'get', path: '/v1/catalog/menu', summary: 'Categories, brands and collections', auth: 'public', response: catalog.menu },
  { method: 'get', path: '/v1/catalog/home', summary: 'Home page sections', auth: 'public', response: catalog.home },
  { method: 'get', path: '/v1/catalog/collections/{slug}', summary: 'Collection title and description', auth: 'public', response: catalog.collection },
  { method: 'get', path: '/v1/search', summary: 'Search results (listing shape; q min 2 characters)', auth: 'public', query: catalogQuerySchema, response: catalog.productList },
  { method: 'get', path: '/v1/search/suggest', summary: 'Type-ahead (min 2 characters)', auth: 'public', query: z.object({ q: z.string().min(2) }), response: catalog.suggest },
  { method: 'get', path: '/v1/catalog/products/{slug}/questions', summary: 'Published product questions', auth: 'public', response: catalog.questions },
  { method: 'post', path: '/v1/catalog/products/{slug}/questions', summary: 'Ask a question (published after staff answer)', auth: 'guest-or-member', body: z.object({ authorName: z.string().min(1).max(60), question: z.string().min(5).max(500) }), status: 201 },
  { method: 'get', path: '/v1/branches', summary: 'The stores', auth: 'public', response: catalog.branches },
  { method: 'get', path: '/v1/geo/provinces', summary: 'Provinces', auth: 'public', response: catalog.provinces },
  { method: 'get', path: '/v1/geo/districts', summary: 'Districts of a province', auth: 'public', query: z.object({ provinceCode: z.string() }), response: catalog.districts },
  { method: 'get', path: '/v1/geo/communes', summary: 'Communes of a district', auth: 'public', query: z.object({ districtCode: z.string() }), response: catalog.communes },

  { method: 'post', path: '/v1/auth/session', summary: 'Create/refresh the user after Firebase sign-in; merges the guest bag', auth: 'member', response: account.session },
  { method: 'get', path: '/v1/me', summary: 'Profile', auth: 'member', response: account.me },
  { method: 'get', path: '/v1/me/addresses', summary: 'Saved addresses', auth: 'member', response: account.addresses },
  { method: 'post', path: '/v1/me/addresses', summary: 'Add an address', auth: 'member', body: addressCreateSchema, response: account.addressResponse, status: 201 },
  { method: 'patch', path: '/v1/me/addresses/{id}', summary: 'Edit an address', auth: 'member', body: addressPatchSchema, response: account.addressResponse },
  { method: 'patch', path: '/v1/me', summary: 'Edit profile (name, preferred sizes, home branch)', auth: 'member', body: profilePatchSchema, response: account.me },
  { method: 'delete', path: '/v1/me', summary: 'Delete my account (refused while an order is in progress)', auth: 'member', status: 204 },
  { method: 'delete', path: '/v1/me/addresses/{id}', summary: 'Delete an address', auth: 'member', status: 204 },
  { method: 'post', path: '/v1/me/addresses/{id}/default', summary: 'Make an address the default', auth: 'member', response: account.addressResponse },
  { method: 'get', path: '/v1/me/wishlist', summary: 'Wishlist', auth: 'member', response: account.wishlist },
  { method: 'put', path: '/v1/me/wishlist/{product}', summary: 'Save a product (id or slug)', auth: 'member', status: 204 },
  { method: 'delete', path: '/v1/me/wishlist/{product}', summary: 'Remove a saved product', auth: 'member', status: 204 },

  { method: 'get', path: '/v1/cart', summary: 'The bag, priced by the server', auth: 'guest-or-member', response: commerce.cartResponse },
  { method: 'post', path: '/v1/cart/items', summary: 'Add to bag', auth: 'guest-or-member', body: z.object({ variantId: z.string().uuid(), qty: z.number().int().min(1).max(20), customPrint: customPrintSchema.optional() }), response: commerce.cartResponse },
  { method: 'patch', path: '/v1/cart/items/{id}', summary: 'Change size or quantity', auth: 'guest-or-member', body: z.object({ qty: z.number().int().min(1).max(20).optional(), variantId: z.string().uuid().optional() }), response: commerce.cartResponse },
  { method: 'delete', path: '/v1/cart/items/{id}', summary: 'Remove a bag line', auth: 'guest-or-member', response: commerce.cartResponse },
  { method: 'delete', path: '/v1/cart/promo', summary: 'Remove the promo code', auth: 'guest-or-member', response: commerce.cartResponse },
  { method: 'put', path: '/v1/cart/promo', summary: 'Enter a promo code', auth: 'guest-or-member', body: z.object({ code: z.string().min(1).max(40) }), response: commerce.cartResponse },
  { method: 'post', path: '/v1/checkout/quote', summary: 'Totals, delivery options, pickup stores and payment methods', auth: 'guest-or-member', body: quoteSchema, response: commerce.quote },
  { method: 'post', path: '/v1/orders', summary: 'Place the order and start payment', auth: 'guest-or-member', body: placeOrderSchema, response: commerce.placedOrder, status: 201, headers: [idemHeader] },
  { method: 'get', path: '/v1/orders/{number}', summary: 'Order with timeline and the latest payment', auth: 'order-owner', response: commerce.orderResponse, headers: [orderToken] },
  { method: 'get', path: '/v1/orders/{number}/payment-status', summary: 'Poll every 3 s while paying', auth: 'order-owner', response: commerce.paymentStatus, headers: [orderToken] },
  { method: 'post', path: '/v1/orders/{number}/payments', summary: 'Retry or switch payment method', auth: 'order-owner', body: z.object({ method: z.enum(['aba_khqr', 'card', 'acleda', 'wing']), contactPhone: z.string().optional(), orderAccessToken: z.string().optional() }), response: commerce.newPayment, status: 201 },
  { method: 'post', path: '/v1/orders/{number}/cancel', summary: 'Cancel an unpaid order (owner)', auth: 'order-owner', body: z.object({ contactPhone: z.string().optional(), orderAccessToken: z.string().optional() }), response: commerce.orderResponse },
  { method: 'post', path: '/v1/orders/track', summary: 'Track with order number + phone (masked); returns an order token while the order awaits payment', auth: 'public', body: z.object({ orderNumber: z.string(), phone: z.string() }), response: commerce.trackResponse },
  { method: 'get', path: '/v1/me/orders', summary: 'Order history', auth: 'member', response: commerce.myOrders },
  { method: 'get', path: '/v1/me/orders/{number}', summary: 'One of my orders', auth: 'member', response: commerce.orderResponse },
  { method: 'get', path: '/v1/me/returns', summary: 'My returns', auth: 'member', response: account.returns },
  { method: 'post', path: '/v1/me/returns', summary: 'Ask for a size exchange, refund or store credit', auth: 'member', body: rmaCreateSchema, response: account.returnResponse, status: 201 },
  { method: 'get', path: '/v1/me/loyalty', summary: 'Points, tier, progress, perks, history', auth: 'member', response: account.loyalty },
  { method: 'get', path: '/v1/me/insights', summary: 'What I buy most', auth: 'member', response: account.insights },
];

const schema = (s: ZodType, io: 'input' | 'output') => z.toJSONSchema(s, { io, unrepresentable: 'any' });

function build() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const query =
      r.query && 'shape' in r.query
        ? Object.entries((r.query as unknown as { shape: Record<string, ZodType> }).shape).map(([name, s]) => ({ name, in: 'query', required: false, schema: schema(s, 'input') }))
        : [];
    const headers = (r.headers ?? []).map((h) => ({ name: h.name, in: 'header', required: h.required, description: h.description, schema: { type: 'string' } }));
    const status = String(r.status ?? 200);
    (paths[r.path] ??= {})[r.method] = {
      summary: r.summary,
      tags: [r.path.split('/')[2]],
      security: r.auth === 'member' ? [{ firebase: [] }] : r.auth === 'public' ? [] : [{}, { firebase: [] }],
      'x-auth': r.auth,
      parameters: [...params, ...query, ...headers],
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(r.body, 'input') } } } } : {}),
      responses: {
        [status]: r.response ? { description: 'OK', content: { 'application/json': { schema: schema(r.response, 'output') } } } : { description: 'OK' },
        default: { description: 'Error', content: { 'application/json': { schema: schema(common.errorBody, 'output') } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Sport Castle API',
      version: '1.0.0',
      description: 'Public and member endpoints of the Sport Castle store API. Money is in integer US cents. Guests have a bag via the httpOnly sc_cart cookie (send credentials).',
    },
    servers: [{ url: 'http://localhost:3000' }],
    components: { securitySchemes: { firebase: { type: 'http', scheme: 'bearer', description: 'Firebase ID token' } } },
    paths,
  };
}

mkdirSync('docs/api', { recursive: true });
writeFileSync('docs/api/openapi.json', `${JSON.stringify(build(), null, 2)}\n`);
console.log(`docs/api/openapi.json: ${ROUTES.length} operations`);
