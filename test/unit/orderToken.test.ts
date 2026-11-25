import { describe, expect, it } from 'vitest';
import { signOrderToken, verifyOrderToken } from '../../src/modules/checkout/orderToken.js';

const SECRET = 'x'.repeat(40);
const now = new Date('2026-11-25T10:00:00Z');

describe('guest order access token', () => {
  it('verifies for the same order before it expires', () => {
    const t = signOrderToken('SC-2611-AAAAA', SECRET, now);
    expect(verifyOrderToken(t, 'SC-2611-AAAAA', SECRET, new Date(now.getTime() + 23 * 3600_000))).toBe(true);
  });
  it('fails for another order, after 24 hours, or when tampered', () => {
    const t = signOrderToken('SC-2611-AAAAA', SECRET, now);
    expect(verifyOrderToken(t, 'SC-2611-BBBBB', SECRET, now)).toBe(false);
    expect(verifyOrderToken(t, 'SC-2611-AAAAA', SECRET, new Date(now.getTime() + 25 * 3600_000))).toBe(false);
    expect(verifyOrderToken(`${t}x`, 'SC-2611-AAAAA', SECRET, now)).toBe(false);
    expect(verifyOrderToken(t, 'SC-2611-AAAAA', 'y'.repeat(40), now)).toBe(false);
    expect(verifyOrderToken('garbage', 'SC-2611-AAAAA', SECRET, now)).toBe(false);
  });
});
