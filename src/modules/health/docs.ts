import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { problem } from '../../lib/openapi.js';
import { z } from '../../lib/zod.js';

export function registerHealthDocs(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['Health'],
    summary: 'Liveness: the process is running',
    responses: {
      200: { description: 'Alive', content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } } },
      500: problem('Unexpected error'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/ready',
    tags: ['Health'],
    summary: 'Readiness: the database answers within 2 seconds',
    responses: {
      200: { description: 'Ready', content: { 'application/json': { schema: z.object({ status: z.literal('ready') }) } } },
      503: problem('Database not reachable'),
    },
  });
}
