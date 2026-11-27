import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';

/**
 * Starting sales for the products the shop opens with in Best sellers, highest first. Each is matched by its
 * name (a case-insensitive pattern), so products added through the admin are found too. A product gets its
 * starting sales once: a later start does not put back a row an admin deleted, and a pattern that found no
 * product yet is tried again on the next start.
 */
export const STARTING_BEST_SELLERS: { key: string; pattern: string; units: number }[] = [
  { key: 'barcelona-2627-home', pattern: 'barcelona.*2026/27.*home', units: 70 },
  { key: 'argentina-3-star-champions', pattern: 'argentina.*3-star.*champions', units: 64 },
  { key: 'france-1998-home-retro', pattern: 'france.*1998.*home', units: 58 },
  { key: 'brazil-2627-home', pattern: 'brazil.*2026/27.*home', units: 52 },
  { key: 'ac-milan-0607-home-retro', pattern: 'ac milan.*2006.?.?07', units: 46 },
  { key: 'mercedes-2026-f1-team-jersey', pattern: 'mercedes.*2026 f1 team jersey', units: 40 },
  { key: 'man-united-9899', pattern: 'manchester united.*1998', units: 34 },
  { key: 'liverpool-2627-home', pattern: 'liverpool.*2026/27.*home', units: 28 },
];

/**
 * Products taken off the starting list. Their head start is removed once, and only the row this seed added
 * (note "Starting best seller"), so real sales and rows an admin set by hand stay.
 */
export const RETIRED_BEST_SELLERS: { key: string; pattern: string }[] = [
  { key: 'psg-2627-third-ucl', pattern: 'paris saint-germain.*2026/27.*third' },
];

const SETTING = 'sales_baseline_applied';

export async function seedBestSellers(db: Db): Promise<{ applied: string[]; missing: string[]; removed: string[] }> {
  const done = await db.execute<{ keys: string[] | null }>(sql`select value->'keys' as keys from settings where key = ${SETTING}`);
  const retiredDone = await db.execute<{ keys: string[] | null }>(sql`select value->'retired' as keys from settings where key = ${SETTING}`);
  const already = new Set(done.rows[0]?.keys ?? []);
  const retired = new Set(retiredDone.rows[0]?.keys ?? []);
  const removed: string[] = [];
  for (const item of RETIRED_BEST_SELLERS) {
    if (retired.has(item.key)) continue;
    await db.execute(sql`
      delete from sales_baseline sb using products p
      where sb.product_id = p.id and sb.note = 'Starting best seller' and (p.name_i18n->>'en') ~* ${item.pattern}`);
    removed.push(item.key);
  }
  const applied: string[] = [];
  const missing: string[] = [];
  for (const item of STARTING_BEST_SELLERS) {
    if (already.has(item.key)) continue;
    const found = await db.execute<{ id: string }>(sql`
      select id from products
      where status <> 'archived' and (name_i18n->>'en') ~* ${item.pattern}
      order by (status = 'active') desc, created_at
      limit 1`);
    const id = found.rows[0]?.id;
    if (!id) {
      missing.push(item.key);
      continue;
    }
    await db.execute(sql`
      insert into sales_baseline (product_id, units, note) values (${id}, ${item.units}, 'Starting best seller')
      on conflict (product_id) do nothing`);
    applied.push(item.key);
  }
  if (applied.length || removed.length) {
    const keys = JSON.stringify([...already, ...applied]);
    const gone = JSON.stringify([...retired, ...removed]);
    await db.execute(sql`
      insert into settings (key, value) values (${SETTING}, jsonb_build_object('keys', ${keys}::jsonb, 'retired', ${gone}::jsonb))
      on conflict (key) do update set value = excluded.value`);
  }
  return { applied, missing, removed };
}
