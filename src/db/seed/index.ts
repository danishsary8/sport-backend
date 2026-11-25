import { sql } from 'drizzle-orm';
import type { Db } from '../client.js';
import { branches, geoCommunes, geoDistricts, geoProvinces } from '../schema/index.js';
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
