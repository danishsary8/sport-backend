import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { users } from '../../src/db/schema/index.js';
import { createAddress } from '../../src/modules/account/addresses.js';
import { updateProfile } from '../../src/modules/account/service.js';
import { closeTestDb, resetDb, testDb } from '../helpers/db.js';

let database: Database;
beforeAll(async () => {
  database = await testDb();
});
afterAll(closeTestDb);
beforeEach(async () => {
  await resetDb(database);
});

/** A user row as loaded by requireUser, then deleted before the handler writes. */
async function userDeletedMidRequest() {
  const [user] = await database.db.insert(users).values({ firebaseUid: 'racer', phoneE164: '+85512345678' }).returning();
  await database.db.update(users).set({ deletedAt: new Date(), phoneE164: null }).where(eq(users.id, user!.id));
  return user!;
}

describe('writes racing account deletion', () => {
  it('does not put profile data back on a deleted account', async () => {
    const stale = await userDeletedMidRequest();
    await expect(updateProfile(database.db, stale, { fullName: 'Sok Dara' })).rejects.toMatchObject({ status: 403 });
    const [row] = await database.db.select().from(users).where(eq(users.id, stale.id));
    expect(row?.fullName).toBeNull();
  });

  it('does not store an address on a deleted account', async () => {
    const stale = await userDeletedMidRequest();
    const d = await database.pool.query("select code from geo_districts where province_code = '12' limit 1");
    const c = await database.pool.query('select code from geo_communes where district_code = $1 limit 1', [d.rows[0].code]);
    await expect(
      createAddress(database.db, stale.id, {
        label: 'Home',
        recipientName: 'Sok Dara',
        phone: '+85512345678',
        provinceCode: '12',
        districtCode: d.rows[0].code,
        communeCode: c.rows[0].code,
        street: 'Street 1',
      }),
    ).rejects.toMatchObject({ status: 403 });
    const left = await database.pool.query('select count(*)::int as n from addresses');
    expect(left.rows[0].n).toBe(0);
  });
});
