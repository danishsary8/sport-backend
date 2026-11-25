import { describe, expect, it } from 'vitest';
import { customPrintSchema, printFeeCents, printKey } from '../../src/modules/pricing/print.js';

const fees = { baseCents: 800, patches: { none: 0, ucl: 500, cpl: 400, aff: 400, champions: 500, 'f1-paddock': 500 } };

describe('customPrintSchema', () => {
  it('normalises names to uppercase single-spaced', () => {
    expect(customPrintSchema.parse({ name: ' sok  dara ', number: 7, patch: 'none' })).toEqual({
      name: 'SOK DARA',
      number: 7,
      patch: 'none',
      font: 'pro-condensed',
    });
  });

  it('rejects names that are too long or use other characters', () => {
    expect(customPrintSchema.safeParse({ name: 'A'.repeat(15), number: 7, patch: 'none' }).success).toBe(false);
    expect(customPrintSchema.safeParse({ name: 'JOSÉ', number: 7, patch: 'none' }).success).toBe(false);
    expect(customPrintSchema.safeParse({ name: '   ', number: 7, patch: 'none' }).success).toBe(false);
    expect(customPrintSchema.safeParse({ name: "O'NEIL-JR.", number: 7, patch: 'none' }).success).toBe(true);
  });

  it('accepts numbers 1 to 99 only', () => {
    expect(customPrintSchema.safeParse({ name: 'A', number: 0, patch: 'none' }).success).toBe(false);
    expect(customPrintSchema.safeParse({ name: 'A', number: 100, patch: 'none' }).success).toBe(false);
    expect(customPrintSchema.safeParse({ name: 'A', number: 7.5, patch: 'none' }).success).toBe(false);
  });

  it('rejects unknown patches and fonts', () => {
    expect(customPrintSchema.safeParse({ name: 'A', number: 7, patch: 'gold' }).success).toBe(false);
    expect(customPrintSchema.safeParse({ name: 'A', number: 7, patch: 'none', font: 'comic' }).success).toBe(false);
  });
});

describe('printKey and printFeeCents', () => {
  it('gives equal prints the same key and no print an empty key', () => {
    const a = customPrintSchema.parse({ name: 'dara', number: 10, patch: 'cpl' });
    const b = customPrintSchema.parse({ name: ' DARA ', number: 10, patch: 'cpl' });
    expect(printKey(a)).toBe(printKey(b));
    expect(printKey(null)).toBe('');
  });

  it('charges the base fee plus the patch, or nothing for Pro members', () => {
    const p = customPrintSchema.parse({ name: 'DARA', number: 10, patch: 'ucl' });
    expect(printFeeCents(p, fees, false)).toBe(1300);
    expect(printFeeCents(p, fees, true)).toBe(0);
    expect(printFeeCents(null, fees, false)).toBe(0);
  });
});
