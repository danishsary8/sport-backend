import { eq } from 'drizzle-orm';
import type { Exec } from '../../db/exec.js';
import { cartItems, type CartItemRow, type CartRow, type UserRow } from '../../db/schema/index.js';
import { CART_LIMITS, type CartLineView, type CartView } from '../cart/types.js';
import { sellable, variantInfo, type VariantInfo } from '../cart/variants.js';
import { availabilityOf, publicMaxQty } from '../catalog/availability.js';
import { pick, type Lang } from '../catalog/i18n.js';
import { safetyBuffer } from '../catalog/listing.js';
import { assetUrl } from '../catalog/view.js';
import { deliveryRate, findPromotion, loadRules, tierFor, type DeliveryChoice } from '../pricing/context.js';
import { priceCart } from '../pricing/engine.js';
import type { CustomPrint } from '../pricing/print.js';
import type { Breakdown, DeliveryInput, PriceLineInput, PricingInput } from '../pricing/types.js';

export interface CheckoutPricingOptions {
  user?: Pick<UserRow, 'id' | 'phoneE164'>;
  delivery: DeliveryChoice;
  lang: Lang;
  assetBase: string;
  now?: Date;
  /** Price with this code instead of the one saved on the cart (undefined = use the cart's). */
  promoOverride?: string | null;
}

export interface PricedCheckout {
  cart: CartRow | undefined;
  items: CartItemRow[];
  infos: Map<string, VariantInfo>;
  pricing: Breakdown;
  view: CartView;
  /** The promotion that actually applied, if any. */
  promotionId: string | null;
  /** Same bag, different delivery choice (no database calls). */
  reprice(delivery: DeliveryInput): Breakdown;
}

/**
 * The one pricing path for the bag, the checkout quote and order placement:
 * current prices, stock, member tier, promo and delivery choice, through priceCart.
 */
export async function pricedCheckout(db: Exec, cart: CartRow | undefined, opts: CheckoutPricingOptions): Promise<PricedCheckout> {
  // One after another: inside a transaction they share one client, which can't run queries in parallel.
  const buffer = await safetyBuffer(db);
  const rules = await loadRules(db);
  const tier = await tierFor(db, opts.user);
  const delivery = await deliveryRate(db, opts.delivery);
  const items = cart ? await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id)).orderBy(cartItems.createdAt, cartItems.id) : [];
  const infos = await variantInfo(db, [...new Set(items.map((i) => i.variantId))], buffer);
  const promoCode = opts.promoOverride !== undefined ? opts.promoOverride : (cart?.promoCode ?? null);
  const promoLookup = promoCode ? await findPromotion(db, promoCode, opts.now ?? new Date()) : null;

  const inputs: PriceLineInput[] = items.map((item) => {
    const info = infos.get(item.variantId);
    return {
      lineId: item.id,
      categorySlug: info?.category_slug ?? '',
      brandSlug: info?.brand_slug ?? '',
      unitPriceCents: info?.price_cents ?? 0,
      compareAtCents: info?.compare_at_cents ?? null,
      qty: item.qty,
      customPrint: (item.customPrint as CustomPrint | null) ?? null,
      purchasable: sellable(info),
    };
  });
  const input: PricingInput = {
    lines: inputs,
    tier,
    promo: {
      promotion: promoLookup && 'promotion' in promoLookup ? promoLookup.promotion : null,
      rejectedMessage: promoLookup && 'rejectedMessage' in promoLookup ? promoLookup.rejectedMessage : undefined,
      enteredCode: promoCode ? promoCode.trim().toUpperCase() : null,
    },
    delivery,
    rules,
  };
  const pricing = priceCart(input);

  const lines: CartLineView[] = items.map((item, i) => {
    const info = infos.get(item.variantId);
    const priced = pricing.lines[i]!;
    const purchasable = sellable(info);
    const units = info?.units ?? 0;
    const maxQty = publicMaxQty(units, CART_LIMITS.maxQty);
    return {
      id: item.id,
      productSlug: info?.product_slug ?? '',
      productName: info ? (pick(info.name_i18n, opts.lang) ?? info.product_slug) : 'Unavailable item',
      brand: info?.brand_name ?? '',
      imageUrl: assetUrl(opts.assetBase, info?.image_path),
      size: info?.size_label ?? '',
      color: info?.color ?? '',
      sku: info?.sku ?? '',
      qty: item.qty,
      maxQty,
      ...availabilityOf(info?.units ?? 0),
      customPrint: (item.customPrint as CustomPrint | null) ?? null,
      unitPriceCents: info?.price_cents ?? 0,
      compareAtCents: info?.compare_at_cents ?? null,
      printFeeCents: priced.printFeeCents,
      discountCents: priced.discountCents,
      lineTotalCents: priced.totalCents,
      purchasable,
      problem: !purchasable ? 'unavailable' : item.qty > Math.min(units, CART_LIMITS.maxQty) ? 'exceeds_stock' : null,
    };
  });

  const view: CartView = {
    id: cart?.id ?? null,
    lines,
    pricing,
    promoCode: cart?.promoCode ?? null,
    checkoutReady: lines.length > 0 && lines.every((l) => l.problem === null) && pricing.shippingCents !== null,
    notices: ["Items in your bag aren't reserved until you check out"],
  };
  return {
    cart,
    items,
    infos,
    pricing,
    view,
    reprice: (d) => priceCart({ ...input, delivery: d }),
    promotionId: promoLookup && 'promotionId' in promoLookup && pricing.promo.applied ? promoLookup.promotionId : null,
  };
}
