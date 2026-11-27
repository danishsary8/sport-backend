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
  { key: 'psg-2627-third-ucl', pattern: 'paris saint-germain.*2026/27.*third', units: 58 },
  { key: 'brazil-2627-home', pattern: 'brazil.*2026/27.*home', units: 52 },
  { key: 'ac-milan-0607-home-retro', pattern: 'ac milan.*2006.?.?07', units: 46 },
  { key: 'mercedes-2026-f1-team-jersey', pattern: 'mercedes.*2026 f1 team jersey', units: 40 },
  { key: 'man-united-9899', pattern: 'manchester united.*1998', units: 34 },
];

const SETTING = 'sales_baseline_applied';

export async function seedBestSellers(db: Db): Promise<{ applied: string[]; missing: string[] }> {
  const done = await db.execute<{ keys: string[] | null }>(sql`select value->'keys' as keys from settings where key = ${SETTING}`);
  const already = new Set(done.rows[0]?.keys ?? []);
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
  if (applied.length) {
    const keys = JSON.stringify([...already, ...applied]);
    await db.execute(sql`
      insert into settings (key, value) values (${SETTING}, jsonb_build_object('keys', ${keys}::jsonb))
      on conflict (key) do update set value = excluded.value`);
  }
  return { applied, missing };
}
