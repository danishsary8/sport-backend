import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalog } from '../../src/contracts/index.js';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { memberApp } from '../helpers/app.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeAll(async () => {
  database = await testDb();
  await seed(database.db);
});
afterAll(async () => {
  await q("delete from settings where key = 'custom_print_fees'");
  await seed(database.db);
  await closeTestDb();
});

describe('GET /v1/catalog/print-options', () => {
  it('lists the print fees, patches and fonts', async () => {
    const res = await request(memberApp(database).app).get('/v1/catalog/print-options').expect(200);
    expect(catalog.printOptions.safeParse(res.body).success).toBe(true);
    expect(res.body.baseCents).toBe(800);
    expect(res.body.patches.map((p: { id: string }) => p.id)).toEqual(['none', 'ucl', 'cpl', 'aff', 'champions', 'f1-paddock']);
    expect(res.body.patches.find((p: { id: string }) => p.id === 'ucl')).toEqual({ id: 'ucl', label: 'Champions League', feeCents: 500 });
    expect(res.body.fonts).toHaveLength(3);
    expect(res.body).toMatchObject({ nameMaxLength: 14, numberMin: 1, numberMax: 99 });
    expect(res.headers['cache-control']).toContain('public');
  });

  it('follows the price settings', async () => {
    await q("update settings set value = jsonb_set(value, '{baseCents}', '1000') where key = 'custom_print_fees'");
    const res = await request(memberApp(database).app).get('/v1/catalog/print-options').expect(200);
    expect(res.body.baseCents).toBe(1000);
  });
});
