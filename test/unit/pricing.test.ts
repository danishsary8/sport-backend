import { describe, expect, it } from 'vitest';
import { priceCart } from '../../src/modules/pricing/engine.js';
import { customPrintSchema } from '../../src/modules/pricing/print.js';
import type { PriceLineInput, PricingInput, PricingRules, PromotionInput, TierId } from '../../src/modules/pricing/types.js';

const rules: PricingRules = {
  khrRate: 4100,
  printFees: { baseCents: 800, patches: { none: 0, ucl: 500, cpl: 400, aff: 400, champions: 500, 'f1-paddock': 500 } },
  team: { minItems: 5, percent: 10, categories: ['jerseys', 'f1'] },
  loyalty: {
    pointsPerUsd: 10,
    tiers: [
      { id: 'bronze', minSpendCents: 0 },
      { id: 'silver', minSpendCents: 15000 },
      { id: 'gold', minSpendCents: 30000 },
      { id: 'pro', minSpendCents: 50000 },
    ],
    memberDiscount: { fromTier: 'silver', percent: 10, categories: ['boots', 'jerseys', 'f1', 'balls', 'essentials'] },
    freeDelivery: { fromTier: 'gold', methods: ['pp_rider'] },
    freePrinting: { fromTier: 'pro' },
  },
};

const PP = { fulfillment: 'delivery' as const, methodId: 'pp_rider', rate: { feeCents: 250, freeOverCents: 5000 } };
const COURIER = { fulfillment: 'delivery' as const, methodId: 'province_courier', rate: { feeCents: 300, freeOverCents: null } };
const PICKUP = { fulfillment: 'pickup' as const, methodId: 'pickup', rate: { feeCents: 0, freeOverCents: null } };

let n = 0;
function line(categorySlug: string, unitPriceCents: number, qty = 1, extra: Partial<PriceLineInput> = {}): PriceLineInput {
  n += 1;
  return { lineId: `l${n}`, categorySlug, brandSlug: 'nike', unitPriceCents, compareAtCents: null, qty, customPrint: null, purchasable: true, ...extra };
}
const jersey = (qty = 1, extra: Partial<PriceLineInput> = {}) => line('jerseys', 3500, qty, extra);
const boot = (qty = 1) => line('boots', 25500, qty);

const CASTLE10: PromotionInput = { code: 'CASTLE10', name: '10% off', type: 'percent', value: 10, minSubtotalCents: 0, scope: {} };
const PPFREE: PromotionInput = { code: 'PPFREE', name: 'Free PP delivery', type: 'free_shipping', value: 0, minSubtotalCents: 0, scope: { methods: ['pp_rider'] } };

function price(opts: { lines: PriceLineInput[]; tier?: TierId | null; promo?: PromotionInput | null; rejected?: string; delivery?: PricingInput['delivery'] }) {
  return priceCart({
    lines: opts.lines,
    tier: opts.tier ?? null,
    promo: { promotion: opts.promo ?? null, rejectedMessage: opts.rejected, enteredCode: opts.promo?.code ?? null },
    delivery: opts.delivery ?? PICKUP,
    rules,
  });
}

describe('basics', () => {
  it('prices a single jersey for a guest picking up in store', () => {
    const b = price({ lines: [jersey()] });
    expect(b).toMatchObject({ merchandiseCents: 3500, shippingCents: 0, totalCents: 3500, totalKhr: 143500, discounts: [] });
    expect(b.lines[0]).toMatchObject({ unitPriceCents: 3500, qty: 1, subtotalCents: 3500, discountCents: 0, totalCents: 3500 });
  });

  it('adds the print fee per unit', () => {
    const print = customPrintSchema.parse({ name: 'DARA', number: 10, patch: 'cpl' });
    const b = price({ lines: [jersey(2, { customPrint: print })] });
    expect(b.lines[0]).toMatchObject({ printFeeCents: 1200, subtotalCents: 2 * (3500 + 1200) });
  });

  it('leaves non-purchasable lines out of every total', () => {
    const b = price({ lines: [jersey(), line('boots', 25500, 1, { purchasable: false })] });
    expect(b.merchandiseCents).toBe(3500);
    expect(b.totalCents).toBe(3500);
    expect(b.lines[1]).toMatchObject({ purchasable: false, totalCents: 0 });
  });

  it('rounds percentage discounts per line', () => {
    const b = price({ lines: [line('jerseys', 3333, 3)], promo: CASTLE10 });
    expect(b.discounts).toEqual([{ kind: 'promo', label: 'Code CASTLE10', amountCents: 1000 }]);
  });
});

describe('team discount', () => {
  it('takes 10% off when the bag has 5 or more jerseys', () => {
    const b = price({ lines: [jersey(5)] });
    expect(b.discounts).toEqual([{ kind: 'team', label: 'Team discount (5+ jerseys)', amountCents: 1750 }]);
    expect(b.totalCents).toBe(15750);
  });

  it('nudges at 3–4 jerseys and gives nothing yet', () => {
    const b = price({ lines: [jersey(4)] });
    expect(b.discounts).toEqual([]);
    expect(b.messages).toContain('Add 1 more jersey to unlock the 10% team discount');
  });
});

describe('member perks', () => {
  it('gives Silver members 10% off', () => {
    const b = price({ lines: [boot()], tier: 'silver' });
    expect(b.discounts).toEqual([{ kind: 'member', label: 'Silver member discount', amountCents: 2550 }]);
    expect(b.memberPerks).toEqual({ tier: 'silver', applied: ['member_discount'] });
  });

  it('never stacks the team and member 10% on one line', () => {
    const b = price({ lines: [jersey(5)], tier: 'silver' });
    const off = b.discounts.reduce((s, d) => s + d.amountCents, 0);
    expect(off).toBe(1750);
  });

  it('gives no perks to guests or members without a verified phone', () => {
    expect(price({ lines: [boot()], tier: null }).discounts).toEqual([]);
  });

  it('gives Gold members free Phnom Penh delivery but not courier delivery', () => {
    expect(price({ lines: [jersey()], tier: 'gold', delivery: PP }).shippingCents).toBe(0);
    expect(price({ lines: [jersey()], tier: 'gold', delivery: COURIER }).shippingCents).toBe(300);
  });

  it('gives Pro members free printing', () => {
    const print = customPrintSchema.parse({ name: 'DARA', number: 10, patch: 'ucl' });
    const b = price({ lines: [jersey(1, { customPrint: print })], tier: 'pro' });
    expect(b.lines[0]!.printFeeCents).toBe(0);
    expect(b.memberPerks.applied).toContain('free_printing');
  });
});

describe('promo codes', () => {
  it('applies a percentage code for a Bronze member', () => {
    const b = price({ lines: [boot()], tier: 'bronze', promo: CASTLE10 });
    expect(b.promo).toEqual({ code: 'CASTLE10', applied: true, message: null });
    expect(b.totalCents).toBe(22950);
  });

  it('keeps the member discount when the code saves no more', () => {
    const b = price({ lines: [boot()], tier: 'silver', promo: CASTLE10 });
    expect(b.promo).toEqual({ code: 'CASTLE10', applied: false, message: 'Your Silver member discount saves more than CASTLE10' });
    expect(b.discounts).toEqual([{ kind: 'member', label: 'Silver member discount', amountCents: 2550 }]);
  });

  it('uses the code when it saves more than the member discount', () => {
    const big: PromotionInput = { ...CASTLE10, code: 'BIG20', value: 20 };
    const b = price({ lines: [boot()], tier: 'silver', promo: big });
    expect(b.promo.applied).toBe(true);
    expect(b.discounts).toEqual([{ kind: 'promo', label: 'Code BIG20', amountCents: 5100 }]);
  });

  it('stacks a code on top of the team discount', () => {
    const b = price({ lines: [jersey(5)], promo: CASTLE10 });
    expect(b.discounts).toEqual([
      { kind: 'team', label: 'Team discount (5+ jerseys)', amountCents: 1750 },
      { kind: 'promo', label: 'Code CASTLE10', amountCents: 1575 },
    ]);
  });

  it('splits a fixed code across the lines it covers', () => {
    const five: PromotionInput = { code: 'FIVE', name: '$5 off', type: 'fixed', value: 500, minSubtotalCents: 0, scope: {} };
    const a = line('balls', 3000);
    const c = line('balls', 1000);
    const b = price({ lines: [a, c], promo: five });
    expect(b.lines.map((l) => l.discountCents)).toEqual([375, 125]);
  });

  it('never takes a fixed code below zero', () => {
    const huge: PromotionInput = { code: 'HUGE', name: '$100 off', type: 'fixed', value: 10000, minSubtotalCents: 0, scope: {} };
    const b = price({ lines: [line('balls', 3000)], promo: huge });
    expect(b.totalCents).toBe(0);
  });

  it('explains a code that covers nothing in the bag', () => {
    const balls: PromotionInput = { ...CASTLE10, code: 'BALLS', scope: { categories: ['balls'] } };
    const b = price({ lines: [jersey()], promo: balls });
    expect(b.promo).toEqual({ code: 'BALLS', applied: false, message: "BALLS doesn't apply to the items in your bag" });
  });

  it('explains a minimum spend', () => {
    const min: PromotionInput = { ...CASTLE10, code: 'MIN60', minSubtotalCents: 6000 };
    const b = price({ lines: [jersey()], promo: min });
    expect(b.promo).toEqual({ code: 'MIN60', applied: false, message: 'Spend $25.00 more to use MIN60' });
  });

  it('passes through why a code was rejected', () => {
    const b = price({ lines: [jersey()], rejected: 'That code has expired' });
    expect(b.promo).toEqual({ code: null, applied: false, message: 'That code has expired' });
  });
});

describe('delivery', () => {
  it('charges Phnom Penh delivery under $50 and nudges', () => {
    const b = price({ lines: [line('balls', 4000)], delivery: PP });
    expect(b.shippingCents).toBe(250);
    expect(b.freeDeliveryRemainingCents).toBe(1000);
    expect(b.messages).toContain('Spend $10.00 more for free delivery');
  });

  it('makes Phnom Penh delivery free from $50 after discounts', () => {
    expect(price({ lines: [line('balls', 5000)], delivery: PP }).shippingCents).toBe(0);
    expect(price({ lines: [line('balls', 5000)], promo: CASTLE10, delivery: PP }).shippingCents).toBe(250);
  });

  it('applies PPFREE only to Phnom Penh delivery', () => {
    expect(price({ lines: [jersey()], promo: PPFREE, delivery: PP })).toMatchObject({ shippingCents: 0, promo: { applied: true } });
    expect(price({ lines: [jersey()], promo: PPFREE, delivery: COURIER })).toMatchObject({
      shippingCents: 300,
      promo: { applied: false, message: 'PPFREE is only for Phnom Penh delivery' },
    });
    expect(price({ lines: [jersey()], promo: PPFREE, delivery: PICKUP }).promo.applied).toBe(false);
  });

  it('reports no quote when the delivery option is not available', () => {
    const b = price({ lines: [jersey()], delivery: { fulfillment: 'delivery', methodId: 'pp_rider', rate: null } });
    expect(b.shippingCents).toBeNull();
    expect(b.totalCents).toBe(3500);
    expect(b.messages).toContain('This delivery option is not available for that address');
  });
});
