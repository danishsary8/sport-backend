import { describe, expect, it } from 'vitest';
import { newOrderNumber, tranIdFor } from '../../src/modules/orders/number.js';

describe('order numbers', () => {
  it('uses the SC-YYMM-XXXXX shape with Crockford base32', () => {
    expect(newOrderNumber(new Date('2026-11-25T10:00:00Z'))).toMatch(/^SC-2611-[0-9A-HJKMNP-TV-Z]{5}$/);
  });

  it('takes the month in Phnom Penh time', () => {
    expect(newOrderNumber(new Date('2026-11-30T20:00:00Z'), () => 0)).toBe('SC-2612-00000');
  });

  it('draws each of the 5 characters from the whole Crockford alphabet', () => {
    const picks = [0, 31, 10, 17, 26];
    let i = 0;
    expect(newOrderNumber(new Date('2026-11-25T10:00:00Z'), () => picks[i++]!)).toBe('SC-2611-0ZAHT');
  });

  it('rarely repeats (collisions are retried by the database insert)', () => {
    // 32^5 ≈ 33.5M numbers a month: ~1.5% chance of one duplicate in 1,000, ~1e-6 of three.
    const now = new Date();
    const seen = new Set(Array.from({ length: 1000 }, () => newOrderNumber(now)));
    expect(seen.size).toBeGreaterThanOrEqual(998);
  });

  it('builds a PayWay-safe transaction id per attempt', () => {
    const id = tranIdFor('SC-2611-7Q4K9', 2);
    expect(id).toBe('SC26117Q4K9-2');
    expect(id.length).toBeLessThanOrEqual(20);
  });
});
