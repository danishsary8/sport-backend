import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { addresses, branches, users, type UserRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import type { IdentityProvider } from '../../lib/identity.js';
import type { Logger } from '../../lib/logger.js';

export const JERSEY_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'] as const;

export const profilePatchSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    preferredBootSize: z.string().trim().min(1).max(10),
    preferredJerseySize: z.enum(JERSEY_SIZES),
    homeBranchId: z.string().trim().min(1).max(40),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export async function updateProfile(db: Db, user: UserRow, patch: ProfilePatch): Promise<UserRow> {
  if (patch.homeBranchId !== undefined) {
    const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, patch.homeBranchId));
    if (!branch) {
      throw new AppError('validation_failed', 400, 'Validation failed', [
        { path: 'homeBranchId', message: 'Unknown branch' },
      ]);
    }
  }
  const [updated] = await db
    .update(users)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(users.id, user.id), isNull(users.deletedAt)))
    .returning();
  if (!updated) throw new AppError('account_deleted', 403, 'This account has been deleted');
  return updated;
}

/**
 * Anonymises the account (orders will keep their own snapshots) and removes the Firebase user.
 * The database step comes first, so the account is locked out even if Firebase is unreachable.
 */
export async function deleteAccount(db: Db, identity: IdentityProvider, logger: Logger, user: UserRow): Promise<void> {
  await db.transaction(async (tx) => {
    // Same lock as address writes, so an address saved concurrently can't outlive the deletion.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`addresses:${user.id}`}))`);
    // Orders in progress still need a way to reach the customer.
    const open = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from orders where user_id = ${user.id} and status not in ('completed', 'cancelled', 'expired', 'delivered')`);
    if ((open.rows[0]?.n ?? 0) > 0) {
      throw new AppError('open_orders', 409, 'You have orders in progress; you can delete your account once they are finished');
    }
    // Finished orders stay for the accounts, without who placed them or where they went.
    await tx.execute(sql`
      update orders set
        contact_name = 'Deleted customer', contact_phone_e164 = '+85500000000', contact_email = null, note = null,
        ship_address = case when ship_address is null then null else jsonb_build_object(
          'recipientName', 'Deleted customer',
          'provinceCode', ship_address->'provinceCode', 'provinceName', ship_address->'provinceName',
          'districtCode', ship_address->'districtCode', 'districtName', ship_address->'districtName',
          'communeCode', ship_address->'communeCode', 'communeName', ship_address->'communeName') end,
        updated_at = now()
      where user_id = ${user.id}`);
    await tx.execute(sql`update rma_requests set note = null where user_id = ${user.id}`);
    await tx.delete(addresses).where(eq(addresses.userId, user.id));
    await tx
      .update(users)
      .set({
        phoneE164: null,
        email: null,
        fullName: null,
        photoUrl: null,
        preferredBootSize: null,
        preferredJerseySize: null,
        homeBranchId: null,
        deletedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, user.id));
  });
  try {
    await identity.deleteUser(user.firebaseUid);
  } catch (err) {
    logger.warn({ err, userId: user.id }, 'Firebase user deletion failed; account is anonymised and locked');
  }
}
