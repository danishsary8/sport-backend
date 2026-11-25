import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { seed } from '../../src/db/seed/index.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;

beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);

async function count(table: string): Promise<number> {
  const r = await database.pool.query<{ n: string }>(`select count(*)::text as n from ${table}`);
  return Number(r.rows[0]?.n);
}

describe('seed', () => {
  it('loads branches and every province, district and commune', async () => {
    expect(await count('branches')).toBe(3);
    expect(await count('geo_provinces')).toBe(25);
    expect(await count('geo_districts')).toBe(210);
    expect(await count('geo_communes')).toBe(1652);
  });

  it('is safe to run again', async () => {
    const result = await seed(database.db);
    expect(result).toEqual({ branches: 3, provinces: 25, districts: 210, communes: 1652 });
    expect(await count('geo_communes')).toBe(1652);
  });

  it('stores Khmer and English names', async () => {
    const r = await database.pool.query('select name_en, name_km from geo_provinces where code = $1', ['12']);
    expect(r.rows[0]).toEqual({ name_en: 'Phnom Penh', name_km: 'ភ្នំពេញ' });
  });

  it('links every district and commune to a parent', async () => {
    const orphans = await database.db.execute(sql`
      select
        (select count(*) from geo_districts d left join geo_provinces p on p.code = d.province_code where p.code is null)
        + (select count(*) from geo_communes c left join geo_districts d on d.code = c.district_code where d.code is null)
        as n`);
    expect(Number(orphans.rows[0]?.n)).toBe(0);
  });

  it('stores branch phones in E.164', async () => {
    const r = await database.pool.query('select phone_e164 from branches where id = $1', ['sonthormuk']);
    expect(r.rows[0]?.phone_e164).toBe('+85512889261');
  });
});
