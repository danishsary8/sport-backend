import { and, eq, getTableColumns, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { users, type UserRow } from '../../db/schema/index.js';
import type { AuthClaims } from '../../lib/identity.js';

export interface BootstrapAdmins {
  phones: string[];
  emails: string[];
}

export function isBootstrapAdmin(claims: AuthClaims, bootstrap: BootstrapAdmins): boolean {
  if (claims.phone && bootstrap.phones.includes(claims.phone)) return true;
  return Boolean(claims.email && claims.emailVerified && bootstrap.emails.includes(claims.email.toLowerCase()));
}

/**
 * Creates or refreshes the user for a verified token in one statement, so concurrent first
 * requests can't create duplicates. Deleted users are never revived (returns their row untouched).
 */
export async function upsertFromClaims(
  db: Db,
  claims: AuthClaims,
  bootstrap: BootstrapAdmins,
): Promise<{ user: UserRow; created: boolean }> {
  const verifiedEmail = claims.email && claims.emailVerified ? claims.email.toLowerCase() : null;
  const promote = isBootstrapAdmin(claims, bootstrap);

  return db.transaction(async (tx) => {
    if (claims.phone) {
      // Firebase allows a number on only one user, so a verified token proves current ownership.
      // Free it from any other row (deleted account, user removed in the Firebase console, number
      // unlinked) so the unique constraint never locks the real owner out.
      await tx
        .update(users)
        .set({ phoneE164: null })
        .where(and(eq(users.phoneE164, claims.phone), ne(users.firebaseUid, claims.uid)));
    }

    const rows = await tx
      .insert(users)
      .values({
        firebaseUid: claims.uid,
        phoneE164: claims.phone,
        email: verifiedEmail,
        fullName: claims.name,
        photoUrl: claims.picture,
        role: promote ? 'admin' : 'customer',
      })
      .onConflictDoUpdate({
        target: users.firebaseUid,
        set: {
          // The token is the source of truth: no phone_number claim means the phone was unlinked.
          phoneE164: sql`excluded.phone_e164`,
          email: sql`coalesce(excluded.email, ${users.email})`,
          photoUrl: sql`coalesce(excluded.photo_url, ${users.photoUrl})`,
          fullName: sql`coalesce(${users.fullName}, excluded.full_name)`,
          role: promote ? 'admin' : sql`${users.role}`,
          updatedAt: sql`now()`,
        },
        setWhere: sql`${users.deletedAt} is null`,
      })
      .returning({ ...getTableColumns(users), created: sql<boolean>`(xmax = 0)` });

    const row = rows[0];
    if (row) {
      const { created, ...user } = row;
      return { user, created };
    }
    const [existing] = await tx.select().from(users).where(eq(users.firebaseUid, claims.uid));
    if (!existing) throw new Error('user upsert returned no row');
    return { user: existing, created: false };
  });
}

export async function findById(db: Db, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}
