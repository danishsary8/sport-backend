import { readFileSync } from 'node:fs';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import type { Config } from '../config.js';
import { registerCatalogDocs } from '../modules/catalog/docs.js';
import { registerHealthDocs } from '../modules/health/docs.js';
import { z } from './zod.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export const ProblemSchema = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string(),
    requestId: z.string(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('Problem', { description: 'RFC 9457 problem details. Every error uses this shape.' });

/** A documented error response using the shared Problem schema. */
export function problem(description: string) {
  return { description, content: { 'application/problem+json': { schema: ProblemSchema } } };
}

export function buildOpenApiDocument(config: Pick<Config, 'publicBaseUrl'>) {
  const registry = new OpenAPIRegistry();
  registry.register('Problem', ProblemSchema);
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Access token from POST /v1/auth/login (available from stage 2).',
  });
  registerHealthDocs(registry);
  registerCatalogDocs(registry);

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Sport Castle API',
      version: pkg.version,
      description:
        'API for the Sport Castle football kit store. Prices are integer cents (USD). Errors follow RFC 9457 (`application/problem+json`). Every response carries `X-Request-Id`.',
    },
    servers: [{ url: config.publicBaseUrl }],
    tags: [
      { name: 'Health', description: 'Liveness and readiness probes' },
      { name: 'Catalog', description: 'Products, filters and stock' },
    ],
  });
}
