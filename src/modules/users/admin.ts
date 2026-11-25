import { and, count, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { branches, USER_ROLES, users, type UserRow } from '../../db/schema/index.js';
import type { BootstrapAdmins } from './repo.js';
import { AppError } from '../../lib/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const userSearchSchema = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(USER_ROLES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const roleChangeSchema = z
  .object({
    role: z.enum(USER_ROLES),
    staffBranchId: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .refine((v) => v.role === 'staff' || !v.staffBranchId, {
    message: 'Only staff can be assigned to a branch',
    path: ['staffBranchId'],
  });

export type UserSearch = z.infer<typeof userSearchSchema>;
export type RoleChange = z.infer<typeof roleChangeSchema>;

export async function searchUsers(db: Db, search: UserSearch): Promise<{ users: UserRow[]; total: number }> {
  const conditions: SQL[] = [isNull(users.deletedAt)];
  if (search.role) conditions.push(eq(users.role, search.role));
  if (search.q) {
    const text = `%${search.q.replace(/[%_\\]/g, '\\$&')}%`;
    const digits = search.q.replace(/\D/g, '');
    const matches = [ilike(users.fullName, text), ilike(users.email, text)];
    if (digits.length >= 3) matches.push(ilike(users.phoneE164, `%${digits}%`));
    conditions.push(or(...matches)!);
  }
  const where = and(...conditions);
  const [rows, [totals]] = await Promise.all([
    db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(search.pageSize)
      .offset((search.page - 1) * search.pageSize),
    db.select({ n: count() }).from(users).where(where),
  ]);
  return { users: rows, total: totals?.n ?? 0 };
}

export async function changeRole(db: Db, actor: UserRow, targetId: string, change: RoleChange, bootstrap: BootstrapAdmins = { phones: [], emails: [] }): Promise<UserRow> {
  if (!UUID.test(targetId)) throw new AppError('not_found', 404, 'User not found');
  if (targetId === actor.id) {
    throw new AppError('cannot_change_own_role', 409, 'Ask another admin to change your role');
  }
  if (change.role !== 'admin') {
    const [target] = await db.select({ phone: users.phoneE164, email: users.email }).from(users).where(eq(users.id, targetId));
    const listed = target && ((target.phone && bootstrap.phones.includes(target.phone)) || (target.email && bootstrap.emails.includes(target.email.toLowerCase())));
    if (listed) {
      // They would be made admin again at their next sign-in; the env list is the source of truth.
      throw new AppError('bootstrap_admin', 409, 'This person is a bootstrap admin: remove them from BOOTSTRAP_ADMIN_PHONES / BOOTSTRAP_ADMIN_EMAILS first');
    }
  }
  const staffBranchId = change.role === 'staff' ? (change.staffBranchId ?? null) : null;
  if (staffBranchId) {
    const [branch] = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, staffBranchId));
    if (!branch) {
      throw new AppError('validation_failed', 400, 'Validation failed', [
        { path: 'staffBranchId', message: 'Unknown branch' },
      ]);
    }
  }
  const [updated] = await db
    .update(users)
    .set({ role: change.role, staffBranchId, updatedAt: sql`now()` })
    .where(and(eq(users.id, targetId), isNull(users.deletedAt)))
    .returning();
  if (!updated) throw new AppError('not_found', 404, 'User not found');
  return updated;
}
