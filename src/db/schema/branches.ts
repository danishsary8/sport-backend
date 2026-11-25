import { boolean, doublePrecision, integer, pgTable, text } from 'drizzle-orm/pg-core';

/** The three physical stores. Ids are stable slugs used across stock, orders and staff. */
export const branches = pgTable('branches', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  address: text('address').notNull(),
  district: text('district').notNull(),
  phoneE164: text('phone_e164').notNull(),
  telegram: text('telegram'),
  hours: text('hours').notNull(),
  landmarks: text('landmarks'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  pickupEnabled: boolean('pickup_enabled').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});
