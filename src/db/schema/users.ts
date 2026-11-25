import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { branches } from './branches.js';

export const USER_ROLES = ['customer', 'staff', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firebaseUid: text('firebase_uid').notNull().unique(),
    phoneE164: text('phone_e164').unique(),
    email: text('email'),
    fullName: text('full_name'),
    photoUrl: text('photo_url'),
    role: text('role').$type<UserRole>().notNull().default('customer'),
    staffBranchId: text('staff_branch_id').references(() => branches.id),
    homeBranchId: text('home_branch_id').references(() => branches.id),
    preferredBootSize: text('preferred_boot_size'),
    preferredJerseySize: text('preferred_jersey_size'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [check('users_role_check', sql`${t.role} in ('customer', 'staff', 'admin')`)],
);

export type UserRow = typeof users.$inferSelect;
