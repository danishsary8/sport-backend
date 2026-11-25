import { z } from 'zod';
import { PATCH_IDS } from './print.js';

const tier = z.enum(['bronze', 'silver', 'gold', 'pro']);
const slugList = z.array(z.string().trim().min(1).max(40)).max(20);

/** Each editable pricing setting and its shape. Admin writes and engine reads use the same schemas. */
export const PRICING_SETTINGS = {
  khr_rate: z.object({ rate: z.number().int().min(1000).max(10000) }),
  custom_print_fees: z
    .object({
      baseCents: z.number().int().min(0).max(100_000),
      patches: z.record(z.string(), z.number().int().min(0).max(100_000)),
    })
    .refine((v) => PATCH_IDS.every((id) => id in v.patches), {
      message: `Give a fee for every patch: ${PATCH_IDS.join(', ')}`,
      path: ['patches'],
    }),
  team_discount_rule: z.object({
    minItems: z.number().int().min(1).max(100),
    percent: z.number().int().min(1).max(100),
    categories: slugList,
  }),
  loyalty_rules: z.object({
    pointsPerUsd: z.number().int().min(0).max(1000),
    tiers: z
      .array(z.object({ id: tier, minSpendCents: z.number().int().min(0) }))
      .length(4)
      .refine((t) => t.map((x) => x.id).join() === 'bronze,silver,gold,pro', {
        message: 'Tiers must be bronze, silver, gold, pro in that order',
      })
      .refine((t) => t[0]!.minSpendCents === 0 && t.every((x, i) => i === 0 || x.minSpendCents > t[i - 1]!.minSpendCents), {
        message: 'Bronze starts at 0 and each tier needs a higher spend than the one before',
      }),
    memberDiscount: z.object({ fromTier: tier, percent: z.number().int().min(0).max(100), categories: slugList }),
    freeDelivery: z.object({ fromTier: tier, methods: slugList }),
    freePrinting: z.object({ fromTier: tier }),
  }),
} as const;

export type PricingSettingKey = keyof typeof PRICING_SETTINGS;
export const isPricingSettingKey = (key: string): key is PricingSettingKey => key in PRICING_SETTINGS;
