import { Ajv2020 } from 'ajv/dist/2020.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogFile, seedCatalog } from '../src/db/seed.js';
import { buildTestApp, resetDb } from './setup/test-app.js';

const { app, db, pool } = buildTestApp();
beforeAll(async () => {
  await resetDb(db);
  await seedCatalog(db, loadCatalogFile());
});
afterAll(() => pool.end());

type Operation = { responses: Record<string, { content?: Record<string, unknown> }> };

describe('OpenAPI document', () => {
  it('GET /openapi.json is OpenAPI 3.1 with the catalog and health paths', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('Sport Castle API');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/health', '/ready', '/v1/products', '/v1/products/{slug}']),
    );
    expect(res.body.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('every operation documents a problem+json error response', async () => {
    const res = await request(app).get('/openapi.json');
    for (const [path, methods] of Object.entries(res.body.paths as Record<string, Record<string, Operation>>)) {
      for (const [method, op] of Object.entries(methods)) {
        const errorResponses = Object.entries(op.responses).filter(([code]) => /^[45]/.test(code));
        const hasProblem = errorResponses.some(([, r]) => r.content && 'application/problem+json' in r.content);
        expect(hasProblem, `${method.toUpperCase()} ${path}`).toBe(true);
      }
    }
  });

  it('documented ProductSummary and ProductDetail match real responses', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    ajv.addSchema({ $id: 'spec', components: spec.components });
    const list = await request(app).get('/v1/products?limit=3');
    const detail = await request(app).get(`/v1/products/${list.body.items[0].slug}`);
    const validateList = ajv.getSchema('spec#/components/schemas/ProductList')!;
    const validateDetail = ajv.getSchema('spec#/components/schemas/ProductDetail')!;
    expect(validateList(list.body), JSON.stringify(validateList.errors)).toBe(true);
    expect(validateDetail(detail.body), JSON.stringify(validateDetail.errors)).toBe(true);
  });
});

describe('interactive docs', () => {
  it('GET /docs serves the reference page pointing at the spec', async () => {
    const res = await request(app).get('/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('/openapi.json');
  });

  it('keeps the strict security policy on API routes', async () => {
    const res = await request(app).get('/health');
    const csp = String(res.headers['content-security-policy']);
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'));
    expect(csp).toContain("default-src 'self'");
    expect(scriptSrc?.trim()).toBe("script-src 'self'");
  });
});
