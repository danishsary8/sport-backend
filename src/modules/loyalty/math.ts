import type { TierId } from '../pricing/types.js';

/** Points for a paid order: pointsPerUsd per dollar of the total excluding shipping, rounded down. */
export function pointsFor(totalCents: number, shippingCents: number, pointsPerUsd: number): number {
  return Math.floor((Math.max(0, totalCents - shippingCents) * pointsPerUsd) / 100);
}

/** The highest tier whose threshold the lifetime spend has reached. */
export function tierForSpend(lifetimeSpendCents: number, tiers: { id: TierId; minSpendCents: number }[]): TierId {
  let best: { id: TierId; minSpendCents: number } = { id: 'bronze', minSpendCents: 0 };
  for (const t of tiers) if (lifetimeSpendCents >= t.minSpendCents && t.minSpendCents >= best.minSpendCents) best = t;
  return best.id;
}
