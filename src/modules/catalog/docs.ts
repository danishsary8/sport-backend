import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problem } from '../../lib/openapi.js';
import { z } from '../../lib/zod.js';
import { ProductDetailSchema, ProductListQueryDocSchema, ProductListResponseSchema } from './schemas.js';

export function registerCatalogDocs(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/v1/products',
    tags: ['Catalog'],
    summary: 'List products with filters, sorting and cursor pagination',
    description:
      'Filters combine with AND across keys and OR within a key, e.g. `league=premier-league,la-liga&kit=home`. Unknown league/team/season/brand values return an empty list.',
    request: { query: ProductListQueryDocSchema },
    responses: {
      200: { description: 'A page of products', content: { 'application/json': { schema: ProductListResponseSchema } } },
      400: problem('Invalid query (see `errors`)'),
      429: problem('Too many requests'),
      503: problem('Database unavailable'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/v1/products/{slug}',
    tags: ['Catalog'],
    summary: 'Get one product with stock per size',
    request: {
      params: z.object({ slug: z.string().openapi({ example: 'real-madrid-2026-27-home-authentic-jersey' }) }),
    },
    responses: {
      200: { description: 'The product', content: { 'application/json': { schema: ProductDetailSchema } } },
      404: problem('No product with this slug'),
      429: problem('Too many requests'),
      503: problem('Database unavailable'),
    },
  });
}
