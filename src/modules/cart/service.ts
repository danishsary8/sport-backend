import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { cartItems, carts, type CartRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { safetyBuffer } from '../catalog/listing.js';
import { type DeliveryChoice } from '../pricing/context.js';
import { printKey, type CustomPrint } from '../pricing/print.js';
import type { Tx } from '../stock/service.js';
import { newGuestToken, type CartOwner } from './owner.js';

import { CART_LIMITS, type CartView } from './types.js';
import { sellable, variantInfo, type VariantInfo } from './variants.js';
import { pricedCheckout, type CheckoutPricingOptions } from '../checkout/pricing.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Exec = Db | Tx;

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

export { CART_LIMITS, type CartLineView, type CartView } from './types.js';
export const DEFAULT_DELIVERY: DeliveryChoice = { fulfillment: 'delivery', methodId: 'pp_rider', provinceCode: '12' };

/** Prices the cart from current database prices, stock, member tier, promo and delivery choice. */
export async function cartView(db: Db, cart: CartRow | undefined, opts: CheckoutPricingOptions): Promise<CartView> {
  return (await pricedCheckout(db, cart, opts)).view;
}
