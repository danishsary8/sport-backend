import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { cartItems, carts } from '../../db/schema/index.js';
import { safetyBuffer } from '../catalog/listing.js';
import { CART_LIMITS } from './service.js';

/**
 * Moves a guest bag into the member's bag in one transaction. Quantities for the same
 * (size, print) are added together and capped at what can be sold. The guest bag is deleted,
 * so a replayed or concurrent sign-in finds nothing left to merge.
 */
export async function mergeGuestCart(
  db: Db,
  guestToken: string,
  userId: string,
): Promise<{ mergedLines: number; cappedLines: number } | null> {
  const buffer = await safetyBuffer(db);
  return db.transaction(async (tx) => {
    // Lock order: guest bag, then member bag — the same for every caller.
    const [guest] = await tx.select().from(carts).where(eq(carts.guestToken, guestToken)).for('update');
    if (!guest) return null;
    await tx.insert(carts).values({ userId }).onConflictDoNothing();
    const [member] = await tx.select().from(carts).where(eq(carts.userId, userId)).for('update');

    const guestLines = await tx.select().from(cartItems).where(eq(cartItems.cartId, guest.id));
    const memberLines = await tx.select({ qty: cartItems.qty }).from(cartItems).where(eq(cartItems.cartId, member!.id));
    let units = memberLines.reduce((s, l) => s + l.qty, 0);
    let mergedLines = 0;
    let cappedLines = 0;
    for (const line of guestLines) {
      const stockRow = await tx.execute<{ units: number }>(sql`
        select coalesce(sum(greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer}))), 0)::int as units
        from stock s where s.variant_id = ${line.variantId}`);
      const available = stockRow.rows[0]?.units ?? 0;
      const [existing] = await tx
        .select()
        .from(cartItems)
        .where(and(eq(cartItems.cartId, member!.id), eq(cartItems.variantId, line.variantId), eq(cartItems.printKey, line.printKey)));
      const wanted = (existing?.qty ?? 0) + line.qty;
      const room = CART_LIMITS.maxUnits - units + (existing?.qty ?? 0);
      const qty = Math.max(existing?.qty ?? 0, Math.min(wanted, CART_LIMITS.maxQty, available, room));
      if (qty < wanted) cappedLines += 1;
      mergedLines += 1;
      units += qty - (existing?.qty ?? 0);
      if (existing) {
        if (qty !== existing.qty) await tx.update(cartItems).set({ qty }).where(eq(cartItems.id, existing.id));
      } else if (qty > 0) {
        const lineCount = await tx.select({ id: cartItems.id }).from(cartItems).where(eq(cartItems.cartId, member!.id));
        if (lineCount.length >= CART_LIMITS.maxLines) {
          cappedLines += 1;
          units -= qty;
          continue;
        }
        await tx.insert(cartItems).values({
          cartId: member!.id,
          variantId: line.variantId,
          qty,
          customPrint: line.customPrint,
          printKey: line.printKey,
        });
      }
    }

    if (!member!.promoCode && guest.promoCode) {
      await tx.update(carts).set({ promoCode: guest.promoCode }).where(eq(carts.id, member!.id));
    }
    await tx.update(carts).set({ updatedAt: sql`now()` }).where(eq(carts.id, member!.id));
    await tx.delete(carts).where(eq(carts.id, guest.id));
    return { mergedLines, cappedLines };
  });
}
