import type { CustomPrint, PrintFees } from './print.js';

export type TierId = 'bronze' | 'silver' | 'gold' | 'pro';

export interface LoyaltyRules {
  pointsPerUsd: number;
  tiers: { id: TierId; minSpendCents: number }[];
  memberDiscount: { fromTier: TierId; percent: number; categories: string[] };
  freeDelivery: { fromTier: TierId; methods: string[] };
  freePrinting: { fromTier: TierId };
}

export interface PricingRules {
  khrRate: number;
  printFees: PrintFees;
  team: { minItems: number; percent: number; categories: string[] };
  loyalty: LoyaltyRules;
}

export interface PriceLineInput {
  lineId: string;
  categorySlug: string;
  brandSlug: string;
  unitPriceCents: number;
  compareAtCents: number | null;
  qty: number;
  customPrint: CustomPrint | null;
  purchasable: boolean;
}

export interface PromotionInput {
  code: string | null;
  name: string;
  type: 'percent' | 'fixed' | 'free_shipping';
  value: number;
  minSubtotalCents: number;
  scope: { categories?: string[]; brands?: string[]; methods?: string[] };
}

export interface DeliveryInput {
  fulfillment: 'delivery' | 'pickup';
  methodId: string | null;
  rate: { feeCents: number; freeOverCents: number | null } | null;
}

export interface PricingInput {
  lines: PriceLineInput[];
  /** null = guest, or a member whose phone isn't verified (no perks). */
  tier: TierId | null;
  promo: { promotion: PromotionInput | null; rejectedMessage?: string; enteredCode: string | null };
  delivery: DeliveryInput;
  rules: PricingRules;
}

export interface PricedLine {
  lineId: string;
  unitPriceCents: number;
  printFeeCents: number;
  qty: number;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  discountSource: 'team' | 'member' | null;
  purchasable: boolean;
}

export interface Breakdown {
  lines: PricedLine[];
  merchandiseCents: number;
  discounts: { kind: 'team' | 'member' | 'promo'; label: string; amountCents: number }[];
  shippingCents: number | null;
  totalCents: number;
  totalKhr: number;
  promo: { code: string | null; applied: boolean; message: string | null };
  memberPerks: { tier: TierId | null; applied: ('member_discount' | 'free_delivery' | 'free_printing')[] };
  freeDeliveryRemainingCents: number | null;
  messages: string[];
}
