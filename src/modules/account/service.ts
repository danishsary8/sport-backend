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
