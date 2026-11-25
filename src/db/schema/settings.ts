import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/** Store-wide tunables (KHR rate, reservation minutes, loyalty rules, ...). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
