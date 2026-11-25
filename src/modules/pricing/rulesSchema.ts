import { z } from 'zod';

const tier = z.enum(['bronze', 'silver', 'gold', 'pro']);
const slugList = z.array(z.string().trim().min(1).max(40)).max(20);

/** Each editable pricing setting and its shape. Admin writes and engine reads use the same schemas. */
export const PRICING_SETTINGS = {
  khr_rate: z.object({ rate: z.number().int().min(1000).max(10000) }),
  custom_print_fees: z.object({
    baseCents: z.number().int().min(0).max(100_000),
    patches: z.record(z.string(), z.number().int().min(0).max(100_000)),
  }),
  team_discount_rule: z.object({
    minItems: z.number().int().min(1).max(100),
    percent: z.number().int().min(0).max(100),
    categories: slugList,
  }),
  loyalty_rules: z.object({
    pointsPerUsd: z.number().int().min(0).max(1000),
    tiers: z.array(z.object({ id: tier, minSpendCents: z.number().int().min(0) })).length(4),
    memberDiscount: z.object({ fromTier: tier, percent: z.number().int().min(0).max(100), categories: slugList }),
    freeDelivery: z.object({ fromTier: tier, methods: slugList }),
    freePrinting: z.object({ fromTier: tier }),
  }),
} as const;

export type PricingSettingKey = keyof typeof PRICING_SETTINGS;
export const isPricingSettingKey = (key: string): key is PricingSettingKey => key in PRICING_SETTINGS;
