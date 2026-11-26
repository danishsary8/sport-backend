import { publicCount } from '../catalog/availability.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Config } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import type { Tx } from '../../db/exec.js';
import {
  addresses,
  branches,
  cartItems,
  carts,
  geoCommunes,
  geoDistricts,
  geoProvinces,
  orderItemAllocations,
  orderItems,
  orders,
  promotions,
  type OrderRow,
  type OrderStatus,
  type ProductSnapshot,
  type ShipAddressSnapshot,
  type UserRow,
} from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { assertHierarchy } from '../account/addresses.js';
import { findCart } from '../cart/service.js';
import type { CartOwner } from '../cart/owner.js';
import { enqueueOrderNotifications } from '../notifications/outbox.js';
import { newOrderNumber } from '../orders/number.js';
import { recordEvent } from '../orders/events.js';
import { orderView, type OrderView, type PaymentView } from '../orders/view.js';
import type { PaymentProvider } from '../payments/provider.js';
import { availablePaymentMethods, paymentMethodsEnabled, settingNumber } from '../settings/payments.js';
import { reserveAllocations } from '../stock/locking.js';
import { planAllocations, type AllocationLine } from './allocation.js';
import type { PlaceOrderInput } from './orderInput.js';
import { signOrderToken } from './orderToken.js';
import { startPaymentAttempt } from './paymentAttempt.js';
import { pricedCheckout } from './pricing.js';
import { pgCode, withSerializable } from './serializable.js';

export interface CheckoutDeps {
  db: Db;
  payments: PaymentProvider;
  config: Config;
  now: () => Date;
}

export interface PlacedOrder {
  order: OrderView;
  payment: PaymentView | null;
  paymentError: string | null;
  orderAccessToken: string | null;
}

async function shipAddressFor(db: Db, input: PlaceOrderInput, user: UserRow | undefined): Promise<ShipAddressSnapshot | null> {
  if (input.fulfillment === 'pickup') return null;
  let a: Omit<ShipAddressSnapshot, 'provinceName' | 'districtName' | 'communeName'>;
  if (input.addressId) {
    const [row] = user ? await db.select().from(addresses).where(and(eq(addresses.id, input.addressId), eq(addresses.userId, user.id))) : [];
    if (!row) throw new AppError('not_found', 404, 'That address was not found');
    a = { recipientName: row.recipientName, phoneE164: row.phoneE164, provinceCode: row.provinceCode, districtCode: row.districtCode, communeCode: row.communeCode, street: row.street, landmark: row.landmark, lat: row.lat, lng: row.lng };
  } else {
    const i = input.address!;
    await assertHierarchy(db, i.provinceCode, i.districtCode, i.communeCode);
    a = { recipientName: i.recipientName, phoneE164: i.phone, provinceCode: i.provinceCode, districtCode: i.districtCode, communeCode: i.communeCode, street: i.street, landmark: i.landmark ?? null, lat: i.lat ?? null, lng: i.lng ?? null };
  }
  const [names] = await db
    .select({ pEn: geoProvinces.nameEn, pKm: geoProvinces.nameKm, dEn: geoDistricts.nameEn, dKm: geoDistricts.nameKm, cEn: geoCommunes.nameEn, cKm: geoCommunes.nameKm })
    .from(geoCommunes)
    .innerJoin(geoDistricts, eq(geoDistricts.code, geoCommunes.districtCode))
    .innerJoin(geoProvinces, eq(geoProvinces.code, geoDistricts.provinceCode))
    .where(eq(geoCommunes.code, a.communeCode));
  if (!names) throw new AppError('validation_failed', 400, 'Validation failed', [{ path: 'address.communeCode', message: 'Unknown commune' }]);
  return { ...a, provinceName: { en: names.pEn, km: names.pKm }, districtName: { en: names.dEn, km: names.dKm }, communeName: { en: names.cEn, km: names.cKm } };
}

/** Online-sellable units per (variant, branch) with the branch's tie-break order. */
async function branchAvailability(tx: Tx, variantIds: string[], pickupBranchId: string | undefined) {
  const buffer = await settingNumber(tx, 'online_safety_buffer', 'units', 1);
  const rows = await tx.execute<{ variant_id: string; branch_id: string; sort: number; available: number }>(sql`
    select s.variant_id, s.branch_id, b.sort, greatest(0, s.on_hand - s.reserved - coalesce(s.online_buffer, ${buffer}))::int as available
    from stock s join branches b on b.id = s.branch_id
    where s.variant_id in ${variantIds} ${pickupBranchId ? sql`and s.branch_id = ${pickupBranchId}` : sql``}`);
  const byVariant = new Map<string, { branchId: string; sort: number; available: number }[]>();
  for (const r of rows.rows) {
    const list = byVariant.get(r.variant_id) ?? [];
    list.push({ branchId: r.branch_id, sort: r.sort, available: r.available });
    byVariant.set(r.variant_id, list);
  }
  return byVariant;
}

/** Locks the promotion and counts this customer's uses (paid redemptions + orders still awaiting payment). */
async function claimPromotion(tx: Tx, promotionId: string, userId: string | null, phone: string): Promise<void> {
  const [p] = await tx.select().from(promotions).where(eq(promotions.id, promotionId)).for('update');
  if (!p) return;
  if (p.maxUses !== null && p.usedCount >= p.maxUses) throw new AppError('promo_limit_reached', 409, `${p.code ?? 'This promotion'} has been fully used`);
  if (p.maxUsesPerUser !== null) {
    const used = await tx.execute<{ n: number }>(sql`
      select (
        (select count(*) from promotion_redemptions r where r.promotion_id = ${promotionId}
           and (r.contact_phone_e164 = ${phone} ${userId ? sql`or r.user_id = ${userId}` : sql``}))
        + (select count(*) from orders o where o.promotion_id = ${promotionId}
           and o.status in ('pending_payment', 'awaiting_pickup_payment')
           and (o.contact_phone_e164 = ${phone} ${userId ? sql`or o.user_id = ${userId}` : sql``}))
      )::int as n`);
    if ((used.rows[0]?.n ?? 0) >= p.maxUsesPerUser) {
      throw new AppError('promo_limit_reached', 409, `You've already used ${p.code ?? 'this promotion'} the maximum number of times`);
    }
  }
  await tx.update(promotions).set({ usedCount: sql`${promotions.usedCount} + 1` }).where(eq(promotions.id, promotionId));
}

async function insertOrderWithFreshNumber(tx: Tx, values: Omit<typeof orders.$inferInsert, 'number'>, now: Date): Promise<OrderRow> {
  for (let i = 0; i < 5; i++) {
    const number = newOrderNumber(now);
    try {
      const [row] = await tx.transaction(async (sp) => sp.insert(orders).values({ ...values, number }).returning());
      return row!;
    } catch (error) {
      if (pgCode(error) !== '23505') throw error;
    }
  }
  throw new Error('Could not allocate a unique order number');
}

/** At most this many unpaid orders holding stock per phone (or member): stops one person "selling out" the shop. */
export const MAX_OPEN_UNPAID_ORDERS = 3;

async function assertOpenOrderSlot(tx: Tx, phone: string, userId: string | null, now: Date): Promise<void> {
  const r = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from orders
    where payment_status = 'unpaid'
      and status in ('pending_payment', 'awaiting_pickup_payment')
      and (reserved_until is null or reserved_until > ${now})
      and (contact_phone_e164 = ${phone} ${userId ? sql`or user_id = ${userId}` : sql``})`);
  if ((r.rows[0]?.n ?? 0) >= MAX_OPEN_UNPAID_ORDERS) {
    throw new AppError(
      'too_many_open_orders',
      429,
      `You already have ${MAX_OPEN_UNPAID_ORDERS} orders waiting for payment. Pay for or cancel one of them first.`,
    );
  }
}

/** Bag → order, in one serializable transaction: price, claim promo, reserve stock, snapshot, clear bag. */
export async function placeOrder(deps: CheckoutDeps, owner: CartOwner, user: UserRow | undefined, input: PlaceOrderInput): Promise<PlacedOrder> {
  const { db, config } = deps;
  const enabled = await paymentMethodsEnabled(db, config.paymentsCashOnly);
  if (!availablePaymentMethods(enabled, input.fulfillment).includes(input.paymentMethod)) {
    throw new AppError('payment_method_unavailable', 400, 'That payment method is not available for this order');
  }
  if (input.fulfillment === 'pickup') {
    const [branch] = await db.select().from(branches).where(and(eq(branches.id, input.pickupBranchId!), eq(branches.pickupEnabled, true)));
    if (!branch) throw new AppError('validation_failed', 400, 'Validation failed', [{ path: 'pickupBranchId', message: 'Choose a store that offers pickup' }]);
  }
  const shipAddress = await shipAddressFor(db, input, user);
  const cash = input.paymentMethod === 'cash_on_pickup';
  const holdMinutes = cash ? (await settingNumber(db, 'cash_on_pickup_hours', 'hours', 48)) * 60 : await settingNumber(db, 'reservation_minutes', 'minutes', 30);

  const order = await withSerializable(db, async (tx) => {
    const now = deps.now();
    const cart = await findCart(tx, owner, true);
    const priced = await pricedCheckout(tx, cart, {
      user,
      delivery:
        input.fulfillment === 'pickup'
          ? { fulfillment: 'pickup', pickupBranchId: input.pickupBranchId }
          : { fulfillment: 'delivery', methodId: input.shippingMethodId, provinceCode: shipAddress!.provinceCode },
      lang: input.lang,
      assetBase: config.assetBaseUrl,
      now,
    });
    if (!cart || priced.items.length === 0) throw new AppError('cart_empty', 400, 'Your bag is empty');
    const { view, pricing } = priced;
    const variantOf = new Map(priced.items.map((i) => [i.id, i.variantId]));
    const unavailable = view.lines.some((l) => l.problem === 'unavailable') || pricing.shippingCents === null;
    if (!unavailable && view.lines.some((l) => l.problem === 'exceeds_stock')) {
      throw new AppError('stock_changed', 409, 'Some items sold out while you were checking out', {
        lines: view.lines.filter((l) => l.problem === 'exceeds_stock').map((l) => ({ lineId: l.id, variantId: variantOf.get(l.id)!, available: l.lowStockCount ?? (l.availability === 'out' ? 0 : null) })),
      });
    }
    if (!view.checkoutReady) {
      throw new AppError('checkout_not_ready', 409, 'Please review your bag before checking out', {
        lines: view.lines.filter((l) => l.problem !== null).map((l) => ({ lineId: l.id, problem: l.problem })),
        ...(pricing.shippingCents === null ? { shipping: 'unavailable' } : {}),
      });
    }
    await assertOpenOrderSlot(tx, input.contact.phone, user?.id ?? null, now);
    if (priced.promotionId) await claimPromotion(tx, priced.promotionId, user?.id ?? null, input.contact.phone);

    const variantIds = [...new Set(priced.items.map((i) => i.variantId))];
    const avail = await branchAvailability(tx, variantIds, input.fulfillment === 'pickup' ? input.pickupBranchId : undefined);
    const lines: AllocationLine[] = priced.items.map((i) => ({ lineId: i.id, variantId: i.variantId, qty: i.qty, branches: avail.get(i.variantId) ?? [] }));
    const plan = planAllocations(lines, input.fulfillment === 'pickup' ? { fulfillment: 'pickup', branchId: input.pickupBranchId! } : { fulfillment: 'delivery' });
    if (!plan.ok) {
      throw new AppError('stock_changed', 409, 'Some items sold out while you were checking out', {
        lines: plan.shortfalls.map((s) => ({ lineId: s.lineId, variantId: s.variantId, available: publicCount(s.available) })),
      });
    }

    const discountCents = pricing.merchandiseCents + (pricing.shippingCents ?? 0) - pricing.totalCents;
    const status: OrderStatus = cash ? 'awaiting_pickup_payment' : 'pending_payment';
    const row = await insertOrderWithFreshNumber(
      tx,
      {
        userId: user?.id ?? null,
        contactName: input.contact.name,
        contactPhoneE164: input.contact.phone,
        contactEmail: input.contact.email ?? null,
        contactChannel: input.contact.channel,
        fulfillment: input.fulfillment,
        pickupBranchId: input.fulfillment === 'pickup' ? input.pickupBranchId! : null,
        shipAddress,
        shippingMethodId: input.fulfillment === 'pickup' ? 'pickup' : input.shippingMethodId!,
        status,
        paymentMethod: input.paymentMethod,
        merchandiseCents: pricing.merchandiseCents,
        discountCents,
        shippingCents: pricing.shippingCents ?? 0,
        totalCents: pricing.totalCents,
        khrRate: (await settingNumber(tx, 'khr_rate', 'rate', 4100)),
        totalKhr: pricing.totalKhr,
        promoCode: priced.promotionId ? pricing.promo.code : null,
        promotionId: priced.promotionId,
        pricing: pricing as unknown as Record<string, unknown>,
        note: input.note ?? null,
        reservedUntil: new Date(now.getTime() + holdMinutes * 60_000),
      },
      now,
    );
    try {
      await reserveAllocations(tx, plan.allocations.map((a) => ({ variantId: a.variantId, branchId: a.branchId, qty: a.qty })), row.number);
    } catch (error) {
      // Same shape as the other stock_changed answers: the bag line and its variant.
      if (error instanceof AppError && error.code === 'stock_changed') {
        const short = (error.details as { lines: { variantId: string; available: number }[] }).lines;
        throw new AppError('stock_changed', 409, error.message, {
          lines: short.map((s) => ({ lineId: priced.items.find((i) => i.variantId === s.variantId)?.id ?? null, variantId: s.variantId, available: s.available })),
        });
      }
      throw error;
    }

    const itemIdByLine = new Map<string, string>();
    for (const [idx, item] of priced.items.entries()) {
      const info = priced.infos.get(item.variantId)!;
      const line = pricing.lines[idx]!;
      const snapshot: ProductSnapshot = {
        productId: info.product_id,
        slug: info.product_slug,
        name: info.name_i18n,
        brand: info.brand_name,
        color: info.color,
        size: info.size_label,
        sku: info.sku,
        imagePath: info.image_path,
        categorySlug: info.category_slug,
      };
      const [inserted] = await tx
        .insert(orderItems)
        .values({
          orderId: row.id,
          variantId: item.variantId,
          productSnapshot: snapshot,
          unitPriceCents: line.unitPriceCents,
          compareAtCents: info.compare_at_cents,
          printFeeCents: line.printFeeCents,
          discountCents: line.discountCents,
          lineTotalCents: line.totalCents,
          qty: item.qty,
          customPrint: item.customPrint ?? null,
        })
        .returning({ id: orderItems.id });
      itemIdByLine.set(item.id, inserted!.id);
    }
    await tx.insert(orderItemAllocations).values(plan.allocations.map((a) => ({ orderItemId: itemIdByLine.get(a.lineId)!, branchId: a.branchId, qty: a.qty })));
    await recordEvent(tx, { orderId: row.id, from: null, to: status, kind: 'status', actor: 'customer' });
    await tx.delete(cartItems).where(eq(cartItems.cartId, cart.id));
    await tx.update(carts).set({ promoCode: null, updatedAt: sql`now()` }).where(eq(carts.id, cart.id));
    await enqueueOrderNotifications(tx, 'order_placed', row.id);
    return row;
  });

  let payment: PaymentView | null = null;
  let paymentError: string | null = null;
  if (!cash) {
    try {
      payment = await startPaymentAttempt(deps, order.id, input.paymentMethod);
    } catch (error) {
      // The order exists and the bag is empty: never turn this into a 500. The customer retries payment.
      paymentError = error instanceof AppError ? error.message : 'The payment service is not responding; please try again';
    }
  }
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).orderBy(orderItems.id);
  const branchName = order.pickupBranchId ? (await db.select({ name: branches.name }).from(branches).where(inArray(branches.id, [order.pickupBranchId])))[0]?.name : null;
  return {
    order: orderView(order, items, { lang: input.lang, assetBase: config.assetBaseUrl, pickupBranchName: branchName }),
    payment,
    paymentError,
    orderAccessToken: user ? null : signOrderToken(order.number, config.cookieSecret, deps.now()),
  };
}
