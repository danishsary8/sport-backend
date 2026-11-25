import { z } from 'zod';
import { cents } from './common.js';
import { productCard } from './catalog.js';

export const user = z.strictObject({
  id: z.string().uuid(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  fullName: z.string().nullable(),
  photoUrl: z.string().nullable(),
  role: z.enum(['customer', 'staff', 'admin']),
  staffBranchId: z.string().nullable(),
  homeBranchId: z.string().nullable(),
  preferredBootSize: z.string().nullable(),
  preferredJerseySize: z.string().nullable(),
  phoneVerified: z.boolean(),
  createdAt: z.string(),
});
export const session = z.strictObject({
  user,
  created: z.boolean(),
  cartMerged: z.strictObject({ mergedLines: z.number().int(), cappedLines: z.number().int() }).optional(),
});
export const me = z.strictObject({ user });

const geo = z.strictObject({ code: z.string(), nameEn: z.string(), nameKm: z.string() });
export const address = z.strictObject({
  id: z.string().uuid(),
  label: z.string(),
  recipientName: z.string(),
  phone: z.string(),
  province: geo,
  district: geo,
  commune: geo,
  street: z.string(),
  landmark: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  isDefault: z.boolean(),
  createdAt: z.string(),
});
export const addresses = z.strictObject({ addresses: z.array(address) });
export const addressResponse = z.strictObject({ address });

export const wishlist = z.strictObject({ products: z.array(productCard) });

const tier = z.enum(['bronze', 'silver', 'gold', 'pro']);
export const loyalty = z.strictObject({
  pointsBalance: z.number().int(),
  tier,
  lifetimeSpendCents: cents,
  nextTier: z.strictObject({ id: tier, minSpendCents: cents, remainingCents: cents }).nullable(),
  perks: z.strictObject({
    memberDiscountPercent: z.number().int().optional(),
    memberDiscountCategories: z.array(z.string()).optional(),
    freeDelivery: z.array(z.string()).optional(),
    freePrinting: z.boolean().optional(),
  }),
  pointsPerUsd: z.number(),
  phoneVerified: z.boolean(),
  ledger: z.array(z.strictObject({ delta: z.number().int(), reason: z.string(), note: z.string().nullable(), createdAt: z.string(), orderNumber: z.string().nullable() })),
});

const slice = z.strictObject({ key: z.string(), label: z.string(), itemCount: z.number().int(), orderCount: z.number().int(), spendCents: cents, sharePct: z.number().int() });
export const insights = z.strictObject({
  totalOrders: z.number().int(),
  totalItems: z.number().int(),
  totalSpendCents: cents,
  customPrintedCount: z.number().int(),
  categories: z.array(slice),
  brands: z.array(slice),
  favoriteCategory: slice.nullable(),
  favoriteBrand: slice.nullable(),
});

export const rma = z.strictObject({
  number: z.string(),
  orderNumber: z.string(),
  resolution: z.enum(['refund', 'size_exchange', 'store_credit']),
  status: z.enum(['requested', 'approved', 'rejected']),
  refundCents: cents,
  note: z.string().nullable(),
  items: z.array(z.strictObject({ orderItemId: z.string(), name: z.string(), size: z.string(), qty: z.number().int(), reason: z.string(), refundCents: cents, exchangeSize: z.string().nullable() })),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
});
export const returns = z.strictObject({ returns: z.array(rma) });
export const returnResponse = z.strictObject({ return: rma });
