import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { productImages, products, settings } from '../schema/index.js';
import { rewordReplica } from './replicaWording.js';

/**
 * One-time fixes to live data, run at start-up with the seed. Each runs once: a settings row records it, so text an
 * admin writes later is never changed behind their back. Placed orders (their snapshots) are never touched.
 */
export async function applyDataFixes(db: Db): Promise<{ replicaWording: number }> {
  return { replicaWording: await once(db, 'data_fix:replica_wording_v1', () => replicaWording(db)) };
}

async function once(db: Db, key: string, fix: () => Promise<number>): Promise<number> {
  const [done] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, key));
  if (done) return 0;
  const changed = await fix();
  await db.insert(settings).values({ key, value: { appliedAt: new Date().toISOString(), changed } }).onConflictDoNothing();
  return changed;
}

const strings = <T>(v: T): T =>
  (typeof v === 'string'
    ? rewordReplica(v)
    : Array.isArray(v)
      ? v.map(strings)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strings(x)]))
        : v) as T;

/** Every product is a Grade A replica: remove "Authentic"/"Official" claims from product text (see rewordReplica). */
async function replicaWording(db: Db): Promise<number> {
  let changed = 0;
  await db.transaction(async (tx) => {
    for (const p of await tx.select().from(products)) {
      const next = {
        nameI18n: strings(p.nameI18n),
        shortNameI18n: strings(p.shortNameI18n),
        descriptionI18n: strings(p.descriptionI18n),
        highlights: strings(p.highlights),
        specs: strings(p.specs),
        heroTagline: p.heroTagline === null ? null : rewordReplica(p.heroTagline),
      };
      const before = JSON.stringify([p.nameI18n, p.shortNameI18n, p.descriptionI18n, p.highlights, p.specs, p.heroTagline]);
      if (JSON.stringify([next.nameI18n, next.shortNameI18n, next.descriptionI18n, next.highlights, next.specs, next.heroTagline]) === before) continue;
      await tx.update(products).set({ ...next, updatedAt: sql`now()` }).where(eq(products.id, p.id));
      // The search index is made from the name.
      await tx.execute(sql`
        update products p set search_text = unaccent(lower(concat_ws(' ',
          p.name_i18n->>'en', p.short_name_i18n->>'en', b.name, p.attributes->>'club', p.attributes->>'league',
          (select string_agg(pc.name, ' ') from product_colors pc where pc.product_id = p.id), c.slug)))
        from brands b, categories c where p.id = ${p.id} and b.id = p.brand_id and c.id = p.category_id`);
      changed += 1;
    }
    for (const img of await tx.select({ id: productImages.id, alt: productImages.alt }).from(productImages)) {
      if (img.alt && rewordReplica(img.alt) !== img.alt) await tx.update(productImages).set({ alt: rewordReplica(img.alt) }).where(eq(productImages.id, img.id));
    }
  });
  return changed;
}
