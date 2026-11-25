import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { branches, categories, collections, geoCommunes, geoDistricts, geoProvinces, homeSections, settings } from '../schema/index.js';
import collectionData from './data/collections.json' with { type: 'json' };
import branchData from './data/branches.json' with { type: 'json' };
import communeData from './data/communes.json' with { type: 'json' };
import districtData from './data/districts.json' with { type: 'json' };
import provinceData from './data/provinces.json' with { type: 'json' };

interface GeoRow {
  code: string;
  name: string;
  en_name: string;
}

const BATCH = 500;

/** Top-level shop categories (names from the storefront's CATEGORY_LABELS). */
export const CATEGORY_SEED = [
  { slug: 'boots', nameI18n: { en: 'Football Boots' }, sort: 1 },
  { slug: 'jerseys', nameI18n: { en: 'Jerseys & Kits' }, sort: 2 },
  { slug: 'f1', nameI18n: { en: 'F1 Motorsport' }, sort: 3 },
  { slug: 'balls', nameI18n: { en: 'Match Balls' }, sort: 4 },
  { slug: 'essentials', nameI18n: { en: 'GK & Essentials' }, sort: 5 },
];

/** Settings created once with defaults; never overwritten by later seeds (admins may change them). */
/** Starting home page; only inserted when there are no sections, so admin edits are kept. */
const DEFAULT_HOME_SECTIONS = [
  {
    type: 'hero' as const,
    sort: 1,
    payload: { title: { en: 'Matchday gear for Phnom Penh' }, subtitle: { en: 'Boots, kits and F1 teamwear across 3 branches' }, imagePath: null, link: { collection: 'new-arrivals' } },
  },
  { type: 'product_rail' as const, sort: 2, payload: { title: { en: 'New arrivals' }, query: { tag: ['new'], sort: 'new' } } },
  { type: 'category_grid' as const, sort: 3, payload: { title: { en: 'Shop by category' }, categories: ['boots', 'jerseys', 'f1', 'balls', 'essentials'] } },
  { type: 'product_rail' as const, sort: 4, payload: { title: { en: 'Best sellers' }, query: { tag: ['best_seller'] } } },
];

const DEFAULT_SETTINGS: { key: string; value: Record<string, unknown> }[] = [
  { key: 'online_safety_buffer', value: { units: 1 } },
];

export const provinceOfDistrict = (code: string): string => code.slice(0, -2).padStart(2, '0');
export const districtOfCommune = (code: string): string => code.slice(0, -2);

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) out.push(rows.slice(i, i + BATCH));
  return out;
}

/** Loads branches and Cambodian geo reference data. Safe to run repeatedly (upserts). */
export async function seed(db: Db): Promise<{ branches: number; provinces: number; districts: number; communes: number }> {
  const provinces = provinceData as GeoRow[];
  const districts = districtData as GeoRow[];
  const communes = communeData as GeoRow[];

  const provinceCodes = new Set(provinces.map((p) => p.code));
  const districtCodes = new Set(districts.map((d) => d.code));
  for (const d of districts) {
    if (!provinceCodes.has(provinceOfDistrict(d.code))) throw new Error(`District ${d.code} has no province`);
  }
  for (const c of communes) {
    if (!districtCodes.has(districtOfCommune(c.code))) throw new Error(`Commune ${c.code} has no district`);
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(branches)
      .values(branchData)
      .onConflictDoUpdate({
        target: branches.id,
        set: {
          name: sql`excluded.name`,
          shortName: sql`excluded.short_name`,
          address: sql`excluded.address`,
          district: sql`excluded.district`,
          phoneE164: sql`excluded.phone_e164`,
          telegram: sql`excluded.telegram`,
          hours: sql`excluded.hours`,
          landmarks: sql`excluded.landmarks`,
          sort: sql`excluded.sort`,
        },
      });

    await tx
      .insert(categories)
      .values(CATEGORY_SEED)
      .onConflictDoUpdate({ target: categories.slug, set: { nameI18n: sql`excluded.name_i18n`, sort: sql`excluded.sort` } });
    await tx.insert(settings).values(DEFAULT_SETTINGS).onConflictDoNothing();

    await tx
      .insert(collections)
      .values(
        collectionData.map((c) => ({
          slug: c.slug,
          nameI18n: { en: c.name },
          descriptionI18n: { en: c.description },
          rule: c.rule,
          sort: c.sort,
        })),
      )
      .onConflictDoUpdate({
        target: collections.slug,
        set: { nameI18n: sql`excluded.name_i18n`, descriptionI18n: sql`excluded.description_i18n`, rule: sql`excluded.rule`, sort: sql`excluded.sort` },
      });
    const existingSections = await tx.select({ id: homeSections.id }).from(homeSections).limit(1);
    if (existingSections.length === 0) await tx.insert(homeSections).values(DEFAULT_HOME_SECTIONS);

    const names = { nameKm: sql`excluded.name_km`, nameEn: sql`excluded.name_en` };
    await tx
      .insert(geoProvinces)
      .values(provinces.map((p) => ({ code: p.code, nameKm: p.name, nameEn: p.en_name })))
      .onConflictDoUpdate({ target: geoProvinces.code, set: names });
    for (const batch of chunks(districts)) {
      await tx
        .insert(geoDistricts)
        .values(batch.map((d) => ({ code: d.code, provinceCode: provinceOfDistrict(d.code), nameKm: d.name, nameEn: d.en_name })))
        .onConflictDoUpdate({ target: geoDistricts.code, set: names });
    }
    for (const batch of chunks(communes)) {
      await tx
        .insert(geoCommunes)
        .values(batch.map((c) => ({ code: c.code, districtCode: districtOfCommune(c.code), nameKm: c.name, nameEn: c.en_name })))
        .onConflictDoUpdate({ target: geoCommunes.code, set: names });
    }
  });

  return { branches: branchData.length, provinces: provinces.length, districts: districts.length, communes: communes.length };
}
