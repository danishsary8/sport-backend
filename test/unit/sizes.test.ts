import { describe, expect, it } from 'vitest';
import { sizeSort } from '../../src/modules/catalog/sizes.js';

describe('sizeSort', () => {
  it('orders EU sizes numerically', () => {
    expect(sizeSort('EU 42.5', 0)).toBe(425);
    expect(sizeSort('EU 39', 0)).toBe(390);
  });

  it('orders letter sizes', () => {
    expect(sizeSort('M', 0)).toBeLessThan(sizeSort('L', 0));
    expect(sizeSort('L', 0)).toBeLessThan(sizeSort('XXL', 0));
    expect(sizeSort('XS', 0)).toBeLessThan(sizeSort('S', 0));
  });

  it('orders numbered sizes (balls, gloves)', () => {
    expect(sizeSort('Size 5', 0)).toBe(2005);
    expect(sizeSort('Size 10', 0)).toBeGreaterThan(sizeSort('Size 9', 0));
  });

  it('keeps the given order for anything else', () => {
    expect(sizeSort('S (EU 36–39)', 0)).toBe(9000);
    expect(sizeSort('M (EU 40–43)', 1)).toBe(9001);
  });
});
