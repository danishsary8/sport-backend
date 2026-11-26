import { z } from 'zod';
import { availability, cents, i18n, isoDate } from './common.js';

const customPrint = z.strictObject({ name: z.string(), number: z.number().int(), patch: z.string(), font: z.string() });

export const breakdown = z.strictObject({
  lines: z.array(
    z.strictObject({
      lineId: z.string(),
      unitPriceCents: cents,
      printFeeCents: cents,
      qty: z.number().int(),
      subtotalCents: cents,
      discountCents: cents,
      totalCents: cents,
      discountSource: z.enum(['team', 'member']).nullable(),
      purchasable: z.boolean(),
    }),
  ),
  merchandiseCents: cents,
  discounts: z.array(z.strictObject({ kind: z.enum(['team', 'member', 'promo']), label: z.string(), amountCents: cents })),
  shippingCents: cents.nullable(),
  totalCents: cents,
  totalKhr: z.number().int(),
  promo: z.strictObject({ code: z.string().nullable(), applied: z.boolean(), message: z.string().nullable() }),
  memberPerks: z.strictObject({ tier: z.enum(['bronze', 'silver', 'gold', 'pro']).nullable(), applied: z.array(z.enum(['member_discount', 'free_delivery', 'free_printing'])) }),
  freeDeliveryRemainingCents: cents.nullable(),
  messages: z.array(z.string()),
});

export const cartView = z.strictObject({
  id: z.string().nullable(),
  lines: z.array(
    z.strictObject({
      id: z.string(),
      productSlug: z.string(),
      productName: z.string(),
      brand: z.string(),
      imageUrl: z.string().nullable(),
      size: z.string(),
      color: z.string(),
      sku: z.string(),
      qty: z.number().int(),
      maxQty: z.number().int(),
      availability: availability,
      lowStockCount: z.number().int().nullable(),
      customPrint: customPrint.nullable(),
      unitPriceCents: cents,
      compareAtCents: cents.nullable(),
      printFeeCents: cents,
      discountCents: cents,
      lineTotalCents: cents,
      purchasable: z.boolean(),
      problem: z.enum(['unavailable', 'exceeds_stock']).nullable(),
    }),
  ),
  pricing: breakdown,
  promoCode: z.string().nullable(),
  checkoutReady: z.boolean(),
  notices: z.array(z.string()),
});
export const cartResponse = z.strictObject({ cart: cartView });

export const paymentMethod = z.enum(['aba_khqr', 'card', 'acleda', 'wing', 'cash_on_pickup']);
export const quote = z.strictObject({
  cart: cartView,
  shippingOptions: z.array(z.strictObject({ methodId: z.string(), name: z.string().nullable(), available: z.boolean(), feeCents: cents.nullable(), eta: z.string().nullable() })),
  pickupBranches: z.array(z.strictObject({ id: z.string(), name: z.string() })),
  paymentMethods: z.array(paymentMethod),
});

export const paymentInstructions = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('qr'), qrString: z.string(), deeplink: z.string().nullable(), expiresAt: z.string() }),
  z.strictObject({ kind: z.literal('redirect'), url: z.string(), method: z.enum(['GET', 'POST']), fields: z.record(z.string(), z.string()), expiresAt: z.string() }),
  z.strictObject({ kind: z.literal('none') }),
]);

export const payment = z.strictObject({
  attempt: z.number().int(),
  method: z.string(),
  status: z.enum(['pending', 'approved', 'declined', 'refunded', 'expired', 'cancelled']),
  tranId: z.string(),
  amountCents: cents,
  instructions: paymentInstructions.nullable(),
  expiresAt: z.string().nullable(),
});

const orderStatus = z.enum(['pending_payment', 'awaiting_pickup_payment', 'confirmed', 'printing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled', 'expired']);
const orderItem = z.strictObject({
  id: z.string(),
  productSlug: z.string(),
  name: z.string(),
  brand: z.string(),
  size: z.string(),
  color: z.string(),
  imageUrl: z.string().nullable(),
  qty: z.number().int(),
  unitPriceCents: cents,
  compareAtCents: cents.nullable(),
  printFeeCents: cents,
  discountCents: cents,
  lineTotalCents: cents,
  customPrint: customPrint.nullable(),
  returnableQty: z.number().int().min(0),
});
const shipAddress = z.strictObject({
  recipientName: z.string(),
  phoneE164: z.string(),
  provinceCode: z.string(),
  provinceName: i18n,
  districtCode: z.string(),
  districtName: i18n,
  communeCode: z.string(),
  communeName: i18n,
  street: z.string(),
  landmark: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});
const orderPricing = z.strictObject({
  merchandiseCents: cents,
  discountCents: cents,
  shippingCents: cents,
  totalCents: cents,
  totalKhr: z.number().int(),
  discounts: breakdown.shape.discounts,
  promoCode: z.string().nullable(),
});
const timeline = z.array(z.strictObject({ at: z.string(), from: orderStatus.nullable(), to: orderStatus.nullable(), kind: z.string(), note: z.string().nullable() }));
const orderBase = {
  number: z.string(),
  status: orderStatus,
  paymentStatus: z.enum(['unpaid', 'paid', 'refunded']),
  paymentMethod: paymentMethod,
  fulfillment: z.enum(['delivery', 'pickup']),
  shippingMethodId: z.string().nullable(),
  pickupBranch: z.strictObject({ id: z.string(), name: z.string() }).nullable(),
  items: z.array(orderItem),
  pricing: orderPricing,
  note: z.string().nullable(),
  reservedUntil: z.string().nullable(),
  paidAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  returnWindow: z.strictObject({ exchangeUntil: isoDate, refundUntil: isoDate }).nullable(),
  createdAt: isoDate,
  timeline: timeline.optional(),
};
export const order = z.strictObject({
  ...orderBase,
  contact: z.strictObject({ name: z.string(), phoneE164: z.string(), email: z.string().nullable(), channel: z.enum(['phone', 'telegram', 'whatsapp']) }),
  shipAddress: shipAddress.nullable(),
});
export const trackedOrder = z.strictObject({
  ...orderBase,
  contact: z.strictObject({ name: z.string(), phone: z.string(), channel: z.string() }),
  shipAddress: z.strictObject({ recipient: z.string(), communeName: i18n, districtName: i18n, provinceName: i18n }).nullable(),
});

export const placedOrder = z.strictObject({ order, payment: payment.nullable(), paymentError: z.string().nullable(), orderAccessToken: z.string().nullable() });
export const orderResponse = z.strictObject({ order, payment: payment.nullable() });
export const paymentStatus = z.strictObject({ status: orderStatus, paymentStatus: z.enum(['unpaid', 'paid', 'refunded']), latestPayment: payment.nullable(), reservedUntil: z.string().nullable() });
export const trackResponse = z.strictObject({ order: trackedOrder, orderAccessToken: z.string().nullable() });
export const newPayment = z.strictObject({ payment });
export const myOrders = z.strictObject({
  orders: z.array(
    z.strictObject({
      number: z.string(),
      status: orderStatus,
      paymentStatus: z.enum(['unpaid', 'paid', 'refunded']),
      fulfillment: z.enum(['delivery', 'pickup']),
      totalCents: cents,
      itemCount: z.number().int(),
      firstItem: z.strictObject({ name: z.string(), imageUrl: z.string().nullable() }).nullable(),
      createdAt: isoDate,
    }),
  ),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
