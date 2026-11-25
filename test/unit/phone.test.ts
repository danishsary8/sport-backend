import { describe, expect, it } from 'vitest';
import { normalizePhone } from '../../src/lib/phone.js';

describe('normalizePhone', () => {
  it('converts local Cambodian numbers to E.164', () => {
    expect(normalizePhone('012 345 678')).toBe('+85512345678');
  });

  it('accepts international formatting', () => {
    expect(normalizePhone('+855 96 889 217')).toBe('+85596889217');
  });

  it('rejects numbers that are not valid phones', () => {
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });
});
