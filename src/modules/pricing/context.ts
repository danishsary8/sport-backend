import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Exec } from '../../db/exec.js';
import { branches, geoProvinces, loyaltyAccounts, promotions, settings, shippingMethods, shippingRates } from '../../db/schema/index.js';
import { PRICING_SETTINGS } from './rulesSchema.js';
import type { DeliveryInput, PricingRules, PromotionInput, TierId } from './types.js';

export const PHNOM_PENH = '12';

/** Reads the pricing rules from settings; each key is validated with the admin schema. */
export async function loadRules(db: Exec): Promise<PricingRules> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, Object.keys(PRICING_SETTINGS)));
  const value = (key: keyof typeof PRICING_SETTINGS) => {
    const row = rows.find((r) => r.key === key);
    if (!row) throw new Error(`Pricing setting "${key}" is missing; run npm run db:seed`);
    return PRICING_SETTINGS[key].parse(row.value);
  };
  const khr = value('khr_rate') as { rate: number };
  return {
    khrRate: khr.rate,
    printFees: value('custom_print_fees') as PricingRules['printFees'],
    team: value('team_discount_rule') as PricingRules['team'],
    loyalty: value('loyalty_rules') as PricingRules['loyalty'],
  };
}

/** Member tier for perks; null for guests and for members without a verified phone. */
export async function tierFor(db: Exec, user: { id: string; phoneE164: string | null } | undefined): Promise<TierId | null> {
  if (!user || !user.phoneE164) return null;
  const [row] = await db.select({ tier: loyaltyAccounts.tier }).from(loyaltyAccounts).where(eq(loyaltyAccounts.userId, user.id));
  return (row?.tier as TierId | undefined) ?? 'bronze';
}

export async function findPromotion(
  db: Exec,
  rawCode: string,
  now: Date,
): Promise<{ promotion: PromotionInput; promotionId: string } | { rejectedMessage: string }> {
  const code = rawCode.trim().toUpperCase();
  const [p] = await db.select().from(promotions).where(eq(promotions.code, code));
  if (!p) return { rejectedMessage: "We don't recognise that code" };
  if (!p.active || (p.endsAt && p.endsAt <= now)) return { rejectedMessage: 'That code has expired' };
  if (p.startsAt && p.startsAt > now) return { rejectedMessage: "That code isn't active yet" };
  if (p.maxUses !== null && p.usedCount >= p.maxUses) return { rejectedMessage: 'That code has been fully used' };
  return {
    promotionId: p.id,
    promotion: { code: p.code, name: p.name, type: p.type, value: p.value, minSubtotalCents: p.minSubtotalCents, scope: p.scope },
  };
}

export interface DeliveryChoice {
  fulfillment: 'delivery' | 'pickup';
  methodId?: string;
  provinceCode?: string;
  pickupBranchId?: string;
}

/** The fee for a delivery choice, or rate: null when that choice isn't offered for the address. */
export async function deliveryRate(db: Exec, choice: DeliveryChoice): Promise<DeliveryInput> {
  if (choice.fulfillment === 'pickup') {
    const [branch] = choice.pickupBranchId
      ? await db
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.id, choice.pickupBranchId), eq(branches.pickupEnabled, true)))
      : [];
    return { fulfillment: 'pickup', methodId: 'pickup', rate: branch ? { feeCents: 0, freeOverCents: null } : null };
  }

  const methodId = choice.methodId ?? null;
  const none: DeliveryInput = { fulfillment: 'delivery', methodId, rate: null };
  const province = choice.provinceCode;
  if (!methodId || !province) return none;
  // Riders only cover Phnom Penh; the courier covers every other province.
  if (methodId === 'pp_rider' && province !== PHNOM_PENH) return none;
  if (methodId === 'province_courier' && province === PHNOM_PENH) return none;
  if (methodId === 'pickup') return none;

  const [known] = await db.select({ code: geoProvinces.code }).from(geoProvinces).where(eq(geoProvinces.code, province));
  if (!known) return none;
  const rates = await db
    .select({ provinceCode: shippingRates.provinceCode, feeCents: shippingRates.feeCents, freeOverCents: shippingRates.freeOverCents })
    .from(shippingRates)
    .innerJoin(shippingMethods, eq(shippingMethods.id, shippingRates.methodId))
    .where(
      and(
        eq(shippingRates.methodId, methodId),
        eq(shippingMethods.active, true),
        or(eq(shippingRates.provinceCode, province), isNull(shippingRates.provinceCode)),
      ),
    )
    .orderBy(sql`${shippingRates.provinceCode} is null`);
  const rate = rates[0];
  return rate ? { fulfillment: 'delivery', methodId, rate: { feeCents: rate.feeCents, freeOverCents: rate.freeOverCents } } : none;
}
