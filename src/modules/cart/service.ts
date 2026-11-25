import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { cartItems, carts, type CartRow, type UserRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { availabilityOf, type Availability } from '../catalog/availability.js';
import { pick, type Lang } from '../catalog/i18n.js';
import { safetyBuffer } from '../catalog/listing.js';
import { assetUrl } from '../catalog/view.js';
import { deliveryRate, findPromotion, loadRules, tierFor, type DeliveryChoice } from '../pricing/context.js';
import { priceCart } from '../pricing/engine.js';
import { printKey, type CustomPrint } from '../pricing/print.js';
import type { Breakdown, PriceLineInput } from '../pricing/types.js';
import type { Tx } from '../stock/service.js';
import { newGuestToken, type CartOwner } from './owner.js';

export const CART_LIMITS = { maxLines: 30, maxQty: 20, maxUnits: 50 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Exec = Db | Tx;

interface VariantInfo {
  variant_id: string;
  variant_status: string;
  price_cents: number;
  compare_at_cents: number | null;
  size_label: string;
  sku: string;
  product_id: string;
  product_slug: string;
  product_status: string;
  is_customizable: boolean;
  name_i18n: { en: string; km?: string };
  brand_slug: string;
  brand_name: string;
  category_slug: string;
  color: string;
  image_path: string | null;
  units: number;
}

/** Everything a cart needs to know about variants: product, price, image and units sellable online. */
async function variantInfo(db: Exec, variantIds: string[], buffer: number): Promise<Map<string, VariantInfo>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db.execute<VariantInfo & Record<string, unknown>>(sql`
    select v.id as variant_id, v.status as variant_status, v.price_cents, v.compare_at_cents, v.size_label, v.sku,
      p.id as product_id, p.slug as product_slug, p.status as product_status, p.is_customizable, p.name_i18n,
      b.slug as brand_slug, b.name as brand_name, c.slug as category_slug, pc.name as color,
      (select pi.path from product_images pi where pi.product_id = p.id order by (pi.color_id = v.color_id) desc nulls last, pi.sort, pi.id limit 1) as image_path,
      coalesce((select sum(greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer}))) from stock s where s.variant_id = v.id), 0)::int as units
    from variants v
    join products p on p.id = v.product_id
    join brands b on b.id = p.brand_id
    join categories c on c.id = p.category_id
    join product_colors pc on pc.id = v.color_id
    where v.id in ${variantIds}`);
  return new Map(rows.rows.map((r) => [r.variant_id, r]));
}

const sellable = (v: VariantInfo | undefined) => v !== undefined && v.variant_status === 'active' && v.product_status === 'active';

export async function findCart(db: Exec, owner: CartOwner, lock = false): Promise<CartRow | undefined> {
  if (owner.kind === 'guest' && !owner.token) return undefined;
  const where = owner.kind === 'member' ? eq(carts.userId, owner.userId) : eq(carts.guestToken, owner.token!);
  const query = db.select().from(carts).where(where);
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** Finds or creates the cart (locked for this transaction). A new guest cart returns its token. */
async function ensureCart(tx: Tx, owner: CartOwner): Promise<{ cart: CartRow; newToken?: string }> {
  const existing = await findCart(tx, owner, true);
  if (existing) return { cart: existing };
  if (owner.kind === 'member') {
    await tx.insert(carts).values({ userId: owner.userId }).onConflictDoNothing();
    return { cart: (await findCart(tx, owner, true))! };
  }
  const token = newGuestToken();
  const [cart] = await tx.insert(carts).values({ guestToken: token }).returning();
  return { cart: cart!, newToken: token };
}

async function assertLimits(tx: Tx, cartId: string, changes: { replacing: string[]; newLine: boolean; qty: number }): Promise<void> {
  if (changes.qty > CART_LIMITS.maxQty) {
    throw new AppError('cart_limit', 409, `You can add up to ${CART_LIMITS.maxQty} of one item`);
  }
  const lines = await tx.select({ id: cartItems.id, qty: cartItems.qty }).from(cartItems).where(eq(cartItems.cartId, cartId));
  if (changes.newLine && lines.length >= CART_LIMITS.maxLines) {
    throw new AppError('cart_limit', 409, `Your bag can hold up to ${CART_LIMITS.maxLines} different items`);
  }
  const otherUnits = lines.filter((l) => !changes.replacing.includes(l.id)).reduce((s, l) => s + l.qty, 0);
  const currentUnits = lines.reduce((s, l) => s + l.qty, 0);
  const newUnits = otherUnits + changes.qty;
  // Only block changes that grow the bag past the limit; lowering a quantity is always allowed.
  if (newUnits > CART_LIMITS.maxUnits && newUnits > currentUnits) {
    throw new AppError('cart_limit', 409, `Your bag can hold up to ${CART_LIMITS.maxUnits} items in total`);
  }
}

function assertAvailable(info: VariantInfo, qty: number): void {
  if (qty > info.units) {
    throw new AppError('insufficient_stock', 409, info.units > 0 ? `Only ${info.units} available` : 'This size is sold out', {
      variantId: info.variant_id,
      available: info.units,
    });
  }
}

async function sellableVariant(tx: Tx, variantId: string, buffer: number): Promise<VariantInfo> {
  if (!UUID.test(variantId)) throw new AppError('not_found', 404, 'Product not found');
  const info = (await variantInfo(tx, [variantId], buffer)).get(variantId);
  if (!info || !sellable(info)) throw new AppError('not_found', 404, 'Product not found');
  return info;
}

export async function addItem(
  db: Db,
  owner: CartOwner,
  input: { variantId: string; qty: number; customPrint?: CustomPrint },
): Promise<{ newToken?: string }> {
  const buffer = await safetyBuffer(db);
  return db.transaction(async (tx) => {
    const info = await sellableVariant(tx, input.variantId, buffer);
    if (input.customPrint && !info.is_customizable) {
      throw new AppError('not_customizable', 400, 'This product cannot be printed');
    }
    const { cart, newToken } = await ensureCart(tx, owner);
    const key = printKey(input.customPrint ?? null);
    const [existing] = await tx
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.variantId, input.variantId), eq(cartItems.printKey, key)));
    const qty = (existing?.qty ?? 0) + input.qty;
    await assertLimits(tx, cart.id, { replacing: existing ? [existing.id] : [], newLine: !existing, qty });
    assertAvailable(info, qty);
    if (existing) {
      await tx.update(cartItems).set({ qty }).where(eq(cartItems.id, existing.id));
    } else {
      await tx.insert(cartItems).values({
        cartId: cart.id,
        variantId: input.variantId,
        qty,
        customPrint: (input.customPrint as unknown as Record<string, unknown>) ?? null,
        printKey: key,
      });
    }
    await tx.update(carts).set({ updatedAt: sql`now()` }).where(eq(carts.id, cart.id));
    return { newToken };
  });
}

export async function updateItem(db: Db, owner: CartOwner, itemId: string, patch: { qty?: number; variantId?: string }): Promise<void> {
  const buffer = await safetyBuffer(db);
  await db.transaction(async (tx) => {
    const cart = UUID.test(itemId) ? await findCart(tx, owner, true) : undefined;
    const [line] = cart ? await tx.select().from(cartItems).where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id))) : [];
    if (!cart || !line) throw new AppError('not_found', 404, 'That item is no longer in your bag');

    const targetVariant = patch.variantId ?? line.variantId;
    const info = await sellableVariant(tx, targetVariant, buffer);
    if (patch.variantId && patch.variantId !== line.variantId) {
      const current = (await variantInfo(tx, [line.variantId], buffer)).get(line.variantId);
      if (!current || current.product_id !== info.product_id) {
        throw new AppError('validation_failed', 400, 'Validation failed', [{ path: 'variantId', message: 'Choose a size of the same product' }]);
      }
    }
    const qty = patch.qty ?? line.qty;
    const [merge] =
      targetVariant === line.variantId
        ? []
        : await tx
            .select()
            .from(cartItems)
            .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.variantId, targetVariant), eq(cartItems.printKey, line.printKey)));
    const finalQty = qty + (merge?.qty ?? 0);
    await assertLimits(tx, cart.id, { replacing: merge ? [line.id, merge.id] : [line.id], newLine: false, qty: finalQty });
    assertAvailable(info, finalQty);
    if (merge) {
      await tx.update(cartItems).set({ qty: finalQty }).where(eq(cartItems.id, merge.id));
      await tx.delete(cartItems).where(eq(cartItems.id, line.id));
    } else {
      await tx.update(cartItems).set({ qty: finalQty, variantId: targetVariant }).where(eq(cartItems.id, line.id));
    }
    await tx.update(carts).set({ updatedAt: sql`now()` }).where(eq(carts.id, cart.id));
  });
}

export async function removeItem(db: Db, owner: CartOwner, itemId: string): Promise<void> {
  const cart = await findCart(db, owner);
  if (!cart || !UUID.test(itemId)) return;
  await db.delete(cartItems).where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, cart.id)));
}

export async function setPromo(db: Db, owner: CartOwner, code: string | null): Promise<{ newToken?: string }> {
  return db.transaction(async (tx) => {
    if (code === null) {
      const cart = await findCart(tx, owner, true);
      if (cart) await tx.update(carts).set({ promoCode: null, updatedAt: sql`now()` }).where(eq(carts.id, cart.id));
      return {};
    }
    const { cart, newToken } = await ensureCart(tx, owner);
    await tx.update(carts).set({ promoCode: code.trim().toUpperCase(), updatedAt: sql`now()` }).where(eq(carts.id, cart.id));
    return { newToken };
  });
}

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

export const DEFAULT_DELIVERY: DeliveryChoice = { fulfillment: 'delivery', methodId: 'pp_rider', provinceCode: '12' };

/** Prices the cart from current database prices, stock, member tier, promo and delivery choice. */
export async function cartView(
  db: Db,
  cart: CartRow | undefined,
  opts: { user?: Pick<UserRow, 'id' | 'phoneE164'>; delivery: DeliveryChoice; lang: Lang; assetBase: string; now?: Date },
): Promise<CartView> {
  const [buffer, rules, tier, delivery] = await Promise.all([
    safetyBuffer(db),
    loadRules(db),
    tierFor(db, opts.user),
    deliveryRate(db, opts.delivery),
  ]);
  const items = cart ? await db.select().from(cartItems).where(eq(cartItems.cartId, cart.id)).orderBy(cartItems.createdAt, cartItems.id) : [];
  const infos = await variantInfo(db, [...new Set(items.map((i) => i.variantId))], buffer);
  const promoLookup = cart?.promoCode ? await findPromotion(db, cart.promoCode, opts.now ?? new Date()) : null;

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
  const pricing = priceCart({
    lines: inputs,
    tier,
    promo: {
      promotion: promoLookup && 'promotion' in promoLookup ? promoLookup.promotion : null,
      rejectedMessage: promoLookup && 'rejectedMessage' in promoLookup ? promoLookup.rejectedMessage : undefined,
      enteredCode: cart?.promoCode ?? null,
    },
    delivery,
    rules,
  });

  const lines: CartLineView[] = items.map((item, i) => {
    const info = infos.get(item.variantId);
    const priced = pricing.lines[i]!;
    const purchasable = sellable(info);
    const maxQty = Math.min(CART_LIMITS.maxQty, info?.units ?? 0);
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
      problem: !purchasable ? 'unavailable' : item.qty > maxQty ? 'exceeds_stock' : null,
    };
  });

  return {
    id: cart?.id ?? null,
    lines,
    pricing,
    promoCode: cart?.promoCode ?? null,
    checkoutReady: lines.length > 0 && lines.every((l) => l.problem === null) && pricing.shippingCents !== null,
    notices: ["Items in your bag aren't reserved until you check out"],
  };
}
