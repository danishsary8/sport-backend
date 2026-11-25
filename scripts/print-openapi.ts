/** Prints the OpenAPI document: npx tsx scripts/print-openapi.ts > openapi.json */
import { buildOpenApiDocument } from '../src/lib/openapi.js';

const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080';
process.stdout.write(`${JSON.stringify(buildOpenApiDocument({ publicBaseUrl }), null, 2)}\n`);
