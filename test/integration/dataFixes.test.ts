import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { applyDataFixes } from '../../src/db/fixes/index.js';
import { withCatalog } from '../helpers/catalog.js';
import { closeTestDb, testDb } from '../helpers/db.js';

let database: Database;
const q = (t: string, p: unknown[] = []) => database.pool.query(t, p);

beforeAll(async () => {
  database = await testDb();
  await withCatalog(database);
});
afterAll(closeTestDb);

describe('applyDataFixes: replica wording', () => {
  it('rewords a live product once (names, text, specs, photo alt, search), and never again', async () => {
    const [p] = (await q("select id from products where slug = 'fc-barcelona-2026-27-home-authentic-jersey'")).rows;
    await q(
      `update products set name_i18n = '{"en":"FC Barcelona 2026/27 Home Authentic Jersey","km":"អាវ"}', description_i18n = '{"en":"Official 2026/27 Blaugrana home match shirt."}',
         highlights = '["Authentic vintage mesh","Breathable"]', specs = '{"edition":"2026/27 Authentic Nike Import","weight":"430g (Official Size 5)"}', hero_tagline = 'Authentic kit' where id = $1`,
      [p.id],
    );
    await q(`update product_images set alt = 'FC Barcelona 2026/27 Home Authentic Jersey' where product_id = $1`, [p.id]);
    await q("delete from settings where key = 'data_fix:replica_wording_v1'");

    const fixed = await applyDataFixes(database.db);
    expect(fixed.replicaWording).toBeGreaterThan(0);
    const [row] = (await q('select name_i18n, description_i18n, highlights, specs, hero_tagline, search_text from products where id = $1', [p.id])).rows;
    expect(row.name_i18n).toEqual({ en: 'FC Barcelona 2026/27 Home Jersey', km: 'អាវ' });
    expect(row.description_i18n).toEqual({ en: '2026/27 Blaugrana home match shirt.' });
    expect(row.highlights).toEqual(['Vintage mesh', 'Breathable']);
    expect(row.specs).toEqual({ edition: '2026/27 Grade A Replica', weight: '430g (Official Size 5)' });
    expect(row.hero_tagline).toBe('Kit');
    expect(row.search_text).not.toContain('authentic');
    expect((await q('select alt from product_images where product_id = $1 limit 1', [p.id])).rows[0].alt).toBe('FC Barcelona 2026/27 Home Jersey');

    // Once only: later admin text is left as the admin wrote it.
    await q(`update products set name_i18n = '{"en":"Authentic again"}' where id = $1`, [p.id]);
    expect((await applyDataFixes(database.db)).replicaWording).toBe(0);
    expect((await q('select name_i18n from products where id = $1', [p.id])).rows[0].name_i18n).toEqual({ en: 'Authentic again' });
  });
});
