import { describe, expect, it } from 'vitest';
import { pointsFor, tierForSpend } from '../../src/modules/loyalty/math.js';

const TIERS = [
  { id: 'bronze' as const, minSpendCents: 0 },
  { id: 'silver' as const, minSpendCents: 15000 },
  { id: 'gold' as const, minSpendCents: 30000 },
  { id: 'pro' as const, minSpendCents: 50000 },
];

describe('loyalty maths', () => {
  it('awards points on the total excluding shipping, rounded down', () => {
    expect(pointsFor(5250, 250, 10)).toBe(500);
    expect(pointsFor(99, 0, 10)).toBe(9);
  });

  it('picks the highest tier reached by lifetime spend', () => {
    expect(tierForSpend(14999, TIERS)).toBe('bronze');
    expect(tierForSpend(15000, TIERS)).toBe('silver');
    expect(tierForSpend(30000, TIERS)).toBe('gold');
    expect(tierForSpend(50000, TIERS)).toBe('pro');
  });
});
