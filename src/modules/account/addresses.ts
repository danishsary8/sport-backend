import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { addresses, geoCommunes, geoDistricts, geoProvinces, users, type AddressRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { normalizePhone } from '../../lib/phone.js';

export const MAX_ADDRESSES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const phone = z
  .string()
  .trim()
  .max(40)
  .transform((value, ctx) => {
    const e164 = normalizePhone(value);
    if (!e164) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number' });
      return z.NEVER;
    }
    return e164;
  });
const code = z.string().trim().regex(/^\d{1,8}$/, 'Must be a numeric code');
// Cambodia's bounding box, with a small margin.
const lat = z.number().min(9.5).max(15);
const lng = z.number().min(102).max(108);

const fields = {
  label: z.string().trim().min(1).max(40),
  recipientName: z.string().trim().min(1).max(120),
  phone,
  provinceCode: code,
  districtCode: code,
  communeCode: code,
  street: z.string().trim().min(1).max(240),
  landmark: z.string().trim().max(240).nullable(),
  lat: lat.nullable(),
  lng: lng.nullable(),
  isDefault: z.boolean(),
};

const bothOrNeither = (v: { lat?: number | null; lng?: number | null }) =>
  (v.lat === undefined || v.lat === null) === (v.lng === undefined || v.lng === null);
const coordsMessage = { message: 'lat and lng must be given together', path: ['lat'] };

export const addressCreateSchema = z
  .object({
    ...fields,
    landmark: fields.landmark.optional(),
    lat: fields.lat.optional(),
    lng: fields.lng.optional(),
    isDefault: fields.isDefault.optional(),
  })
  .refine(bothOrNeither, coordsMessage);

export const addressPatchSchema = z
  .object(fields)
  .omit({ isDefault: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export type AddressCreate = z.infer<typeof addressCreateSchema>;
export type AddressPatch = z.infer<typeof addressPatchSchema>;

interface GeoName {
  code: string;
  nameEn: string;
  nameKm: string;
}

export interface AddressView {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  province: GeoName;
  district: GeoName;
  commune: GeoName;
  street: string;
  landmark: string | null;
  lat: number | null;
  lng: number | null;
  isDefault: boolean;
  createdAt: string;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

function invalid(path: string, message: string): AppError {
  return new AppError('validation_failed', 400, 'Validation failed', [{ path, message }]);
}

/** The commune must sit in the district, and the district in the province. */
export async function assertHierarchy(db: Executor, p: string, d: string, c: string): Promise<void> {
  const [district] = await db
    .select({ provinceCode: geoDistricts.provinceCode })
    .from(geoDistricts)
    .where(eq(geoDistricts.code, d));
  if (!district) throw invalid('districtCode', 'Unknown district');
  if (district.provinceCode !== p) throw invalid('districtCode', 'District is not in the chosen province');
  const [commune] = await db
    .select({ districtCode: geoCommunes.districtCode })
    .from(geoCommunes)
    .where(eq(geoCommunes.code, c));
  if (!commune) throw invalid('communeCode', 'Unknown commune');
  if (commune.districtCode !== d) throw invalid('communeCode', 'Commune is not in the chosen district');
}

async function listViews(db: Executor, userId: string, id?: string): Promise<AddressView[]> {
  const rows = await db
    .select({
      a: addresses,
      p: { code: geoProvinces.code, nameEn: geoProvinces.nameEn, nameKm: geoProvinces.nameKm },
      d: { code: geoDistricts.code, nameEn: geoDistricts.nameEn, nameKm: geoDistricts.nameKm },
      c: { code: geoCommunes.code, nameEn: geoCommunes.nameEn, nameKm: geoCommunes.nameKm },
    })
    .from(addresses)
    .innerJoin(geoProvinces, eq(geoProvinces.code, addresses.provinceCode))
    .innerJoin(geoDistricts, eq(geoDistricts.code, addresses.districtCode))
    .innerJoin(geoCommunes, eq(geoCommunes.code, addresses.communeCode))
    .where(id ? and(eq(addresses.userId, userId), eq(addresses.id, id)) : eq(addresses.userId, userId))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt), desc(addresses.id));

  return rows.map(({ a, p, d, c }) => ({
    id: a.id,
    label: a.label,
    recipientName: a.recipientName,
    phone: a.phoneE164,
    province: p,
    district: d,
    commune: c,
    street: a.street,
    landmark: a.landmark,
    lat: a.lat,
    lng: a.lng,
    isDefault: a.isDefault,
    createdAt: a.createdAt.toISOString(),
  }));
}

async function viewOne(db: Executor, userId: string, id: string): Promise<AddressView> {
  const [view] = await listViews(db, userId, id);
  if (!view) throw new AppError('not_found', 404, 'Address not found');
  return view;
}

/** Locks and returns the member's own address, or 404 (never revealing other members' ids). */
async function ownAddress(tx: Tx, userId: string, id: string): Promise<AddressRow> {
  if (!UUID.test(id)) throw new AppError('not_found', 404, 'Address not found');
  const [row] = await tx
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, id), eq(addresses.userId, userId)))
    .for('update');
  if (!row) throw new AppError('not_found', 404, 'Address not found');
  return row;
}

/**
 * Serialises every address write for one member (and account deletion), so the cap, the single
 * default and default promotion hold under concurrent requests. Also refuses writes for an
 * account deleted after the request was authenticated.
 */
export async function lockMemberAddresses(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`addresses:${userId}`}))`);
  const [user] = await tx.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId));
  if (!user || user.deletedAt) throw new AppError('account_deleted', 403, 'This account has been deleted');
}

async function clearDefault(tx: Tx, userId: string): Promise<void> {
  await tx.update(addresses).set({ isDefault: false }).where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)));
}

export function listAddresses(db: Db, userId: string): Promise<AddressView[]> {
  return listViews(db, userId);
}

export async function createAddress(db: Db, userId: string, input: AddressCreate): Promise<AddressView> {
  return db.transaction(async (tx) => {
    await assertHierarchy(tx, input.provinceCode, input.districtCode, input.communeCode);
    await lockMemberAddresses(tx, userId);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(addresses).where(eq(addresses.userId, userId));
    if (n >= MAX_ADDRESSES) {
      throw new AppError('address_limit', 409, `You can save up to ${MAX_ADDRESSES} addresses`);
    }
    const makeDefault = n === 0 || input.isDefault === true;
    if (makeDefault) await clearDefault(tx, userId);
    const [row] = await tx
      .insert(addresses)
      .values({
        userId,
        label: input.label,
        recipientName: input.recipientName,
        phoneE164: input.phone,
        provinceCode: input.provinceCode,
        districtCode: input.districtCode,
        communeCode: input.communeCode,
        street: input.street,
        landmark: input.landmark ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        isDefault: makeDefault,
      })
      .returning({ id: addresses.id });
    return viewOne(tx, userId, row!.id);
  });
}

export async function updateAddress(db: Db, userId: string, id: string, patch: AddressPatch): Promise<AddressView> {
  return db.transaction(async (tx) => {
    await lockMemberAddresses(tx, userId);
    const current = await ownAddress(tx, userId, id);
    const next = {
      provinceCode: patch.provinceCode ?? current.provinceCode,
      districtCode: patch.districtCode ?? current.districtCode,
      communeCode: patch.communeCode ?? current.communeCode,
    };
    if (patch.provinceCode || patch.districtCode || patch.communeCode) {
      await assertHierarchy(tx, next.provinceCode, next.districtCode, next.communeCode);
    }
    const lat = patch.lat !== undefined ? patch.lat : current.lat;
    const lng = patch.lng !== undefined ? patch.lng : current.lng;
    if ((lat === null) !== (lng === null)) throw invalid('lat', 'lat and lng must be given together');

    const { phone: newPhone, ...rest } = patch;
    await tx
      .update(addresses)
      .set({ ...rest, ...(newPhone ? { phoneE164: newPhone } : {}), updatedAt: sql`now()` })
      .where(eq(addresses.id, id));
    return viewOne(tx, userId, id);
  });
}

export async function setDefaultAddress(db: Db, userId: string, id: string): Promise<AddressView> {
  return db.transaction(async (tx) => {
    await lockMemberAddresses(tx, userId);
    await ownAddress(tx, userId, id);
    await clearDefault(tx, userId);
    await tx.update(addresses).set({ isDefault: true, updatedAt: sql`now()` }).where(eq(addresses.id, id));
    return viewOne(tx, userId, id);
  });
}

export async function deleteAddress(db: Db, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockMemberAddresses(tx, userId);
    const row = await ownAddress(tx, userId, id);
    await tx.delete(addresses).where(eq(addresses.id, id));
    if (row.isDefault) {
      const [newest] = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(eq(addresses.userId, userId))
        .orderBy(desc(addresses.createdAt), desc(addresses.id))
        .limit(1);
      if (newest) await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, newest.id));
    }
  });
}
