import { describe, expect, it } from 'vitest';
import { toNinety } from '../../src/modules/catalog/price.js';

describe('toNinety', () => {
  it('moves a price down to the .90 just below it', () => {
    expect(toNinety(1200)).toBe(1190);
    expect(toNinety(1250)).toBe(1190);
    expect(toNinety(1299)).toBe(1290);
    expect(toNinety(9500)).toBe(9490);
    expect(toNinety(24000)).toBe(23990);
  });
  it('keeps prices that already end in .90', () => {
    expect(toNinety(1190)).toBe(1190);
    expect(toNinety(90)).toBe(90);
  });
  it('never goes below $0.90', () => {
    expect(toNinety(1)).toBe(90);
    expect(toNinety(0)).toBe(90);
  });
});
