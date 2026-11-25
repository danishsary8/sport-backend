/**
 * The API contract: Zod schemas for every public and member endpoint's response, plus the request
 * schemas the routers validate with. `scripts/openapi.ts` turns them into docs/api/openapi.json, which the
 * storefront uses to generate its types.
 */
export * as common from './common.js';
export * as catalog from './catalog.js';
export * as commerce from './commerce.js';
export * as account from './account.js';
export { placeOrderSchema } from '../modules/checkout/orderInput.js';
export { quoteSchema } from '../modules/checkout/router.js';
export { rmaCreateSchema } from '../modules/rma/service.js';
export { addressCreateSchema, addressPatchSchema } from '../modules/account/addresses.js';
export { catalogQuerySchema } from '../modules/catalog/listing.js';
export { customPrintSchema } from '../modules/pricing/print.js';
