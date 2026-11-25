import { printFeeCents } from './print.js';
import type { Breakdown, PriceLineInput, PricedLine, PricingInput, PromotionInput, TierId } from './types.js';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pct = (amount: number, percent: number) => Math.round((amount * percent) / 100);
const title = (tier: TierId) => tier.charAt(0).toUpperCase() + tier.slice(1);

interface Working {
  input: PriceLineInput;
  printFee: number;
  subtotal: number;
  team: number;
  member: number;
}

/** Splits `amount` over lines in proportion to their weights; the rounding remainder goes to the largest. */
function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || amount <= 0) return weights.map(() => 0);
  const capped = Math.min(amount, total);
  const shares = weights.map((w) => Math.floor((capped * w) / total));
  const remainder = capped - shares.reduce((s, v) => s + v, 0);
  const largest = weights.indexOf(Math.max(...weights));
  shares[largest]! += remainder;
  return shares;
}

function inScope(line: PriceLineInput, promo: PromotionInput): boolean {
  const { categories, brands } = promo.scope;
  if (categories?.length && !categories.includes(line.categorySlug)) return false;
  if (brands?.length && !brands.includes(line.brandSlug)) return false;
  return true;
}

/**
 * Prices a cart. Pure: the same input always gives the same breakdown, so the cart, the
 * checkout quote and the order (phase 5) can never disagree.
 */
export function priceCart(input: PricingInput): Breakdown {
  const { rules, tier, delivery } = input;
  const rank = (t: TierId) => rules.loyalty.tiers.findIndex((x) => x.id === t);
  const has = (from: TierId) => tier !== null && rank(tier) >= rank(from);
  const freePrinting = has(rules.loyalty.freePrinting.fromTier);
  const messages: string[] = [];

  // 1–2. Purchasable lines with their print fees.
  const working: Working[] = input.lines.map((l) => {
    const printFee = printFeeCents(l.customPrint, rules.printFees, freePrinting);
    return { input: l, printFee, subtotal: l.purchasable ? (l.unitPriceCents + printFee) * l.qty : 0, team: 0, member: 0 };
  });
  const live = working.filter((w) => w.input.purchasable);
  const merchandise = live.reduce((s, w) => s + w.subtotal, 0);

  // 3. Team discount.
  const teamUnits = live.filter((w) => rules.team.categories.includes(w.input.categorySlug)).reduce((s, w) => s + w.input.qty, 0);
  const teamOn = teamUnits >= rules.team.minItems;
  const short = rules.team.minItems - teamUnits;
  if (!teamOn && teamUnits > 0 && short <= 2) {
    messages.push(`Add ${short} more jersey${short === 1 ? '' : 's'} to unlock the ${rules.team.percent}% team discount`);
  }
  // 4. Member discount (per line, never stacked with the team discount).
  const memberOn = has(rules.loyalty.memberDiscount.fromTier);
  for (const w of live) {
    if (teamOn && rules.team.categories.includes(w.input.categorySlug)) w.team = pct(w.subtotal, rules.team.percent);
    if (memberOn && rules.loyalty.memberDiscount.categories.includes(w.input.categorySlug)) {
      w.member = pct(w.subtotal, rules.loyalty.memberDiscount.percent);
    }
  }
  const lineAuto = (w: Working, withMember: boolean) => (withMember ? Math.max(w.team, w.member) : w.team);
  const memberSavings = live.reduce((s, w) => s + Math.max(0, lineAuto(w, true) - w.team), 0);

  // 5. Promo code, priced against keeping the member discount.
  const promotion = input.promo.promotion;
  const code = promotion?.code ?? null;
  let promoApplied = false;
  let promoMessage: string | null = input.promo.rejectedMessage ?? null;
  let promoShares = live.map(() => 0);
  let useMember = true;
  let freeShippingPromo = false;

  if (promotion) {
    const afterTeam = merchandise - live.reduce((s, w) => s + w.team, 0);
    if (afterTeam < promotion.minSubtotalCents) {
      promoMessage = `Spend ${usd(promotion.minSubtotalCents - afterTeam)} more to use ${code}`;
    } else if (promotion.type === 'free_shipping') {
      const methods = promotion.scope.methods;
      if (delivery.fulfillment === 'delivery' && delivery.methodId && (!methods?.length || methods.includes(delivery.methodId))) {
        freeShippingPromo = true;
        promoApplied = true;
        promoMessage = null;
      } else {
        promoMessage =
          methods?.length === 1 && methods[0] === 'pp_rider'
            ? `${code} is only for Phnom Penh delivery`
            : `${code} doesn't apply to this delivery option`;
      }
    } else {
      const scoped = live.map((w) => inScope(w.input, promotion));
      if (!scoped.some(Boolean)) {
        promoMessage = `${code} doesn't apply to the items in your bag`;
      } else {
        const remaining = live.map((w, i) => (scoped[i] ? w.subtotal - w.team : 0));
        const shares =
          promotion.type === 'percent' ? remaining.map((r) => pct(r, promotion.value)) : allocate(promotion.value, remaining);
        const codeSavings = shares.reduce((s, v) => s + v, 0);
        if (codeSavings > memberSavings) {
          promoShares = shares;
          useMember = false;
          promoApplied = true;
          promoMessage = null;
        } else if (memberSavings > 0) {
          promoMessage = `Your ${title(tier!)} member discount saves more than ${code}`;
        } else {
          promoMessage = `${code} doesn't lower the price of the items in your bag`;
        }
      }
    }
  }

  // Final per-line amounts.
  const discounts: Breakdown['discounts'] = [];
  let teamTotal = 0;
  let memberTotal = 0;
  const priced = new Map<Working, PricedLine>();
  live.forEach((w, i) => {
    const auto = lineAuto(w, useMember);
    const source: PricedLine['discountSource'] = auto === 0 ? null : useMember && w.member > w.team ? 'member' : 'team';
    if (source === 'member') memberTotal += auto;
    else teamTotal += auto;
    const discount = Math.min(w.subtotal, auto + promoShares[i]!);
    priced.set(w, {
      lineId: w.input.lineId,
      unitPriceCents: w.input.unitPriceCents,
      printFeeCents: w.printFee,
      qty: w.input.qty,
      subtotalCents: w.subtotal,
      discountCents: discount,
      totalCents: w.subtotal - discount,
      discountSource: source,
      purchasable: true,
    });
  });
  if (teamTotal > 0) discounts.push({ kind: 'team', label: `Team discount (${rules.team.minItems}+ jerseys)`, amountCents: teamTotal });
  if (memberTotal > 0) discounts.push({ kind: 'member', label: `${title(tier!)} member discount`, amountCents: memberTotal });
  const promoTotal = promoShares.reduce((s, v) => s + v, 0);
  if (promoTotal > 0) discounts.push({ kind: 'promo', label: `Code ${code}`, amountCents: promoTotal });

  const lines: PricedLine[] = working.map(
    (w) =>
      priced.get(w) ?? {
        lineId: w.input.lineId,
        unitPriceCents: w.input.unitPriceCents,
        printFeeCents: w.printFee,
        qty: w.input.qty,
        subtotalCents: 0,
        discountCents: 0,
        totalCents: 0,
        discountSource: null,
        purchasable: false,
      },
  );
  const afterDiscounts = lines.reduce((s, l) => s + l.totalCents, 0);

  // 6. Delivery.
  const applied: Breakdown['memberPerks']['applied'] = [];
  if (memberTotal > 0) applied.push('member_discount');
  if (freePrinting && live.some((w) => w.input.customPrint)) applied.push('free_printing');
  let shipping: number | null;
  let freeRemaining: number | null = null;
  if (delivery.fulfillment === 'pickup') {
    shipping = delivery.rate ? 0 : null;
  } else if (!delivery.rate) {
    shipping = null;
  } else {
    const goldFree = has(rules.loyalty.freeDelivery.fromTier) && delivery.methodId !== null && rules.loyalty.freeDelivery.methods.includes(delivery.methodId);
    const thresholdMet = delivery.rate.freeOverCents !== null && afterDiscounts >= delivery.rate.freeOverCents;
    if (goldFree) applied.push('free_delivery');
    if (goldFree || freeShippingPromo || thresholdMet || afterDiscounts === 0) {
      shipping = 0;
    } else {
      shipping = delivery.rate.feeCents;
      if (delivery.rate.freeOverCents !== null) {
        freeRemaining = delivery.rate.freeOverCents - afterDiscounts;
        messages.push(`Spend ${usd(freeRemaining)} more for free delivery`);
      }
    }
  }
  if (shipping === null) messages.push('This delivery option is not available for that address');

  // 7. Totals.
  const total = afterDiscounts + (shipping ?? 0);
  return {
    lines,
    merchandiseCents: merchandise,
    discounts,
    shippingCents: shipping,
    totalCents: total,
    totalKhr: Math.round((total * rules.khrRate) / 10000) * 100,
    promo: { code, applied: promoApplied, message: promoMessage },
    memberPerks: { tier, applied },
    freeDeliveryRemainingCents: freeRemaining,
    messages,
  };
}
