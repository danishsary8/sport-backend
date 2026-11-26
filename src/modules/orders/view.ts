import type { OrderEventRow, OrderItemRow, OrderRow, PaymentRow, ProductSnapshot } from '../../db/schema/index.js';
import { pick, type Lang } from '../catalog/i18n.js';
import { assetUrl } from '../catalog/view.js';
import type { CustomPrint } from '../pricing/print.js';
import type { Breakdown } from '../pricing/types.js';
import type { PaymentInstructions } from '../payments/provider.js';

export interface OrderItemView {
  id: string;
  productSlug: string;
  name: string;
  brand: string;
  size: string;
  color: string;
  imageUrl: string | null;
  qty: number;
  unitPriceCents: number;
  compareAtCents: number | null;
  printFeeCents: number;
  discountCents: number;
  lineTotalCents: number;
  customPrint: CustomPrint | null;
  /** Units the customer may still ask to return or exchange (0 before delivery, after the window, or for printed / hygiene items). */
  returnableQty: number;
}

export interface PaymentView {
  attempt: number;
  method: string;
  status: string;
  tranId: string;
  amountCents: number;
  instructions: PaymentInstructions | null;
  expiresAt: string | null;
}

export interface OrderView {
  number: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  fulfillment: string;
  contact: { name: string; phoneE164: string; email: string | null; channel: string };
  shipAddress: OrderRow['shipAddress'];
  shippingMethodId: string | null;
  pickupBranch: { id: string; name: string } | null;
  items: OrderItemView[];
  pricing: { merchandiseCents: number; discountCents: number; shippingCents: number; totalCents: number; totalKhr: number; discounts: Breakdown['discounts']; promoCode: string | null };
  note: string | null;
  reservedUntil: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  /** Last moments to ask for a size exchange / a refund; null until the order is delivered or collected. */
  returnWindow: { exchangeUntil: string; refundUntil: string } | null;
  createdAt: string;
  timeline?: { at: string; from: string | null; to: string | null; kind: string; note: string | null }[];
}

export interface ReturnInfo {
  window: { exchangeUntil: string; refundUntil: string } | null;
  returnable: Map<string, number>;
}

export function paymentView(p: PaymentRow): PaymentView {
  const instructions = (p.instructions as PaymentInstructions | null) ?? null;
  return {
    attempt: p.attempt,
    method: p.method,
    status: p.status,
    tranId: p.providerTranId,
    amountCents: p.amountCents,
    instructions,
    expiresAt: instructions && 'expiresAt' in instructions ? instructions.expiresAt : null,
  };
}

/** What the customer may see about their order: never stock allocations, staff notes or refund flags. */
export function orderView(
  order: OrderRow,
  items: OrderItemRow[],
  opts: { lang?: Lang; assetBase: string; pickupBranchName?: string | null; events?: OrderEventRow[]; returns?: ReturnInfo },
): OrderView {
  const lang = opts.lang ?? 'en';
  const pricing = order.pricing as unknown as Breakdown;
  return {
    number: order.number,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    fulfillment: order.fulfillment,
    contact: { name: order.contactName, phoneE164: order.contactPhoneE164, email: order.contactEmail, channel: order.contactChannel },
    shipAddress: order.shipAddress,
    shippingMethodId: order.shippingMethodId,
    pickupBranch: order.pickupBranchId ? { id: order.pickupBranchId, name: opts.pickupBranchName ?? order.pickupBranchId } : null,
    items: items.map((i) => {
      const s = i.productSnapshot as ProductSnapshot;
      return {
        id: i.id,
        productSlug: s.slug,
        name: pick(s.name, lang) ?? s.slug,
        brand: s.brand,
        size: s.size,
        color: s.color,
        imageUrl: assetUrl(opts.assetBase, s.imagePath),
        qty: i.qty,
        unitPriceCents: i.unitPriceCents,
        compareAtCents: i.compareAtCents,
        printFeeCents: i.printFeeCents,
        discountCents: i.discountCents,
        lineTotalCents: i.lineTotalCents,
        customPrint: (i.customPrint as CustomPrint | null) ?? null,
        returnableQty: opts.returns?.returnable.get(i.id) ?? 0,
      };
    }),
    pricing: {
      merchandiseCents: order.merchandiseCents,
      discountCents: order.discountCents,
      shippingCents: order.shippingCents,
      totalCents: order.totalCents,
      totalKhr: order.totalKhr,
      discounts: pricing?.discounts ?? [],
      promoCode: order.promoCode,
    },
    note: order.note,
    reservedUntil: order.reservedUntil?.toISOString() ?? null,
    paidAt: order.paidAt?.toISOString() ?? null,
    deliveredAt: order.deliveredAt?.toISOString() ?? null,
    returnWindow: opts.returns?.window ?? null,
    createdAt: order.createdAt.toISOString(),
    ...(opts.events
      ? {
          timeline: opts.events
            .filter((e) => e.kind === 'status')
            .map((e) => ({ at: e.createdAt.toISOString(), from: e.fromStatus, to: e.toStatus, kind: e.kind, note: null })),
        }
      : {}),
  };
}
