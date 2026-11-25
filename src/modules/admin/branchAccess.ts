import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { branches, type UserRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';

/** Staff tied to a branch may only act there; everyone else must name a branch. */
export function branchFor(user: UserRow, requested: string | undefined): string {
  if (user.role === 'staff' && user.staffBranchId) {
    if (requested && requested !== user.staffBranchId) {
      throw new AppError('forbidden', 403, 'You can only manage stock at your own branch');
    }
    return user.staffBranchId;
  }
  if (!requested) {
    throw new AppError('validation_failed', 400, 'Validation failed', [{ path: 'branchId', message: 'Choose a branch' }]);
  }
  return requested;
}

export function assertBranchAccess(user: UserRow, branchId: string): void {
  if (user.role === 'staff' && user.staffBranchId && user.staffBranchId !== branchId) {
    throw new AppError('forbidden', 403, 'You can only manage stock at your own branch');
  }
}

export async function assertBranchExists(db: Db, branchId: string, path = 'branchId'): Promise<void> {
  const [row] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId));
  if (!row) throw new AppError('validation_failed', 400, 'Validation failed', [{ path, message: 'Unknown branch' }]);
}
