import type { Availability } from '../catalog/availability.js';
import type { CustomPrint } from '../pricing/print.js';
import type { Breakdown } from '../pricing/types.js';

export const CART_LIMITS = { maxLines: 30, maxQty: 20, maxUnits: 50 };

export interface CartLineView {
  id: string;
  productSlug: string;
  productName: string;
  brand: string;
  imageUrl: string | null;
  size: string;
  color: string;
  sku: string;
  qty: number;
  maxQty: number;
  availability: Availability;
  lowStockCount: number | null;
  customPrint: CustomPrint | null;
  unitPriceCents: number;
  compareAtCents: number | null;
  printFeeCents: number;
  discountCents: number;
  lineTotalCents: number;
  purchasable: boolean;
  problem: null | 'unavailable' | 'exceeds_stock';
}

export interface CartView {
  id: string | null;
  lines: CartLineView[];
  pricing: Breakdown;
  promoCode: string | null;
  checkoutReady: boolean;
  notices: string[];
}

