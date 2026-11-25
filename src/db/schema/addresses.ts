import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { geoCommunes, geoDistricts, geoProvinces } from './geo.js';
import { users } from './users.js';

export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    recipientName: text('recipient_name').notNull(),
    phoneE164: text('phone_e164').notNull(),
    provinceCode: text('province_code')
      .notNull()
      .references(() => geoProvinces.code),
    districtCode: text('district_code')
      .notNull()
      .references(() => geoDistricts.code),
    communeCode: text('commune_code')
      .notNull()
      .references(() => geoCommunes.code),
    street: text('street').notNull(),
    landmark: text('landmark'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('addresses_user_idx').on(t.userId),
    uniqueIndex('addresses_one_default_idx').on(t.userId).where(sql`${t.isDefault}`),
  ],
);

export type AddressRow = typeof addresses.$inferSelect;
