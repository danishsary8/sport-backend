import { z } from 'zod';
import { PAYMENT_METHODS } from '../../db/schema/index.js';
import { normalizePhone } from '../../lib/phone.js';
import { langSchema } from '../catalog/i18n.js';

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

export const inlineAddressSchema = z
  .object({
    recipientName: z.string().trim().min(1).max(120),
    phone,
    provinceCode: code,
    districtCode: code,
    communeCode: code,
    street: z.string().trim().min(1).max(240),
    landmark: z.string().trim().max(240).nullish(),
    lat: z.number().min(9.5).max(15).nullish(),
    lng: z.number().min(102).max(108).nullish(),
  })
  .refine((v) => (v.lat == null) === (v.lng == null), { message: 'lat and lng must be given together', path: ['lat'] });

export const placeOrderSchema = z
  .object({
    contact: z.object({
      name: z.string().trim().min(1).max(120),
      phone,
      email: z.string().trim().toLowerCase().email().max(200).nullish(),
      channel: z.enum(['phone', 'telegram', 'whatsapp']),
    }),
    fulfillment: z.enum(['delivery', 'pickup']),
    addressId: z.string().uuid().optional(),
    address: inlineAddressSchema.optional(),
    pickupBranchId: z.string().trim().max(40).optional(),
    shippingMethodId: z.enum(['pp_rider', 'province_courier']).optional(),
    paymentMethod: z.enum(PAYMENT_METHODS),
    note: z.string().trim().max(500).optional(),
    acceptTerms: z.literal(true, { error: 'Please accept the terms to place your order' }),
    lang: langSchema,
  })
  .superRefine((v, ctx) => {
    if (v.fulfillment === 'delivery') {
      if (!v.addressId && !v.address) ctx.addIssue({ code: 'custom', path: ['address'], message: 'Add a delivery address' });
      if (v.addressId && v.address) ctx.addIssue({ code: 'custom', path: ['address'], message: 'Send either addressId or address, not both' });
      if (!v.shippingMethodId) ctx.addIssue({ code: 'custom', path: ['shippingMethodId'], message: 'Choose a delivery method' });
    } else if (!v.pickupBranchId) {
      ctx.addIssue({ code: 'custom', path: ['pickupBranchId'], message: 'Choose a store to pick up from' });
    }
  });

export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
