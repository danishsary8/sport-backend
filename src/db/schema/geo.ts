import { index, pgTable, text } from 'drizzle-orm/pg-core';

/** Cambodian administrative divisions (NCDD codes). Read-only reference data loaded by the seed. */
export const geoProvinces = pgTable('geo_provinces', {
  code: text('code').primaryKey(),
  nameKm: text('name_km').notNull(),
  nameEn: text('name_en').notNull(),
});

export const geoDistricts = pgTable(
  'geo_districts',
  {
    code: text('code').primaryKey(),
    provinceCode: text('province_code')
      .notNull()
      .references(() => geoProvinces.code),
    nameKm: text('name_km').notNull(),
    nameEn: text('name_en').notNull(),
  },
  (t) => [index('geo_districts_province_idx').on(t.provinceCode)],
);

export const geoCommunes = pgTable(
  'geo_communes',
  {
    code: text('code').primaryKey(),
    districtCode: text('district_code')
      .notNull()
      .references(() => geoDistricts.code),
    nameKm: text('name_km').notNull(),
    nameEn: text('name_en').notNull(),
  },
  (t) => [index('geo_communes_district_idx').on(t.districtCode)],
);
