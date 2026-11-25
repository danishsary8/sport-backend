import { describe, expect, it } from 'vitest';
import { daysSince, isNonReturnable, newRmaNumber, refundForLine, returnWindowOpen } from '../../src/modules/rma/rules.js';

const RULES = { exchangeDays: 30, refundDays: 14, nonReturnable: ['socks', 'underwear'] };
const DAY = 86_400_000;
const now = new Date('2026-11-25T10:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);

describe('return windows', () => {
  it('counts whole days', () => {
    expect(daysSince(ago(29.9), now)).toBe(29);
    expect(daysSince(ago(30), now)).toBe(30);
  });

  it('allows a size exchange up to 30 days', () => {
    expect(returnWindowOpen('size_exchange', ago(29), now, RULES)).toBe(true);
    expect(returnWindowOpen('size_exchange', ago(30), now, RULES)).toBe(true);
    expect(returnWindowOpen('size_exchange', ago(31), now, RULES)).toBe(false);
  });

  it('allows a refund or store credit up to 14 days', () => {
    expect(returnWindowOpen('refund', ago(13), now, RULES)).toBe(true);
    expect(returnWindowOpen('refund', ago(15), now, RULES)).toBe(false);
    expect(returnWindowOpen('store_credit', ago(15), now, RULES)).toBe(false);
  });
});

describe('what can be returned', () => {
  it('blocks hygiene items by category, garment type or slug word', () => {
    expect(isNonReturnable({ categorySlug: 'socks', productSlug: 'x', garmentType: null }, RULES)).toBe(true);
    expect(isNonReturnable({ categorySlug: 'essentials', productSlug: 'x', garmentType: 'underwear' }, RULES)).toBe(true);
    expect(isNonReturnable({ categorySlug: 'essentials', productSlug: 'trusox-3-0-mid-calf-non-slip-grip-socks', garmentType: null }, RULES)).toBe(true);
    expect(isNonReturnable({ categorySlug: 'boots', productSlug: 'sockeroo-boot', garmentType: null }, RULES)).toBe(false);
  });
});

describe('refund amounts', () => {
  it('refunds the paid share of a line', () => {
    expect(refundForLine(9000, 3, 1)).toBe(3000);
    expect(refundForLine(10000, 3, 1)).toBe(3333);
    expect(refundForLine(10000, 3, 3)).toBe(10000);
  });
});

describe('RMA numbers', () => {
  it('use RMA-YYMM-XXXXX', () => {
    expect(newRmaNumber(now)).toMatch(/^RMA-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/);
  });
});
