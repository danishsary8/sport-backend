import { describe, expect, it } from 'vitest';
import { availabilityOf, onlineAvailable } from '../../src/modules/catalog/availability.js';

describe('onlineAvailable', () => {
  it('sums what each branch can sell online after its buffer', () => {
    expect(
      onlineAvailable([
        { onHand: 10, reserved: 0, buffer: 1 },
        { onHand: 2, reserved: 0, buffer: 1 },
        { onHand: 0, reserved: 0, buffer: 1 },
      ]),
    ).toBe(10);
  });

  it('never counts a branch below zero', () => {
    expect(onlineAvailable([{ onHand: 3, reserved: 3, buffer: 1 }, { onHand: 5, reserved: 0, buffer: 0 }])).toBe(5);
  });
});

describe('availabilityOf', () => {
  it('maps units to public availability without revealing larger counts', () => {
    expect(availabilityOf(0)).toEqual({ availability: 'out', lowStockCount: null });
    expect(availabilityOf(1)).toEqual({ availability: 'low', lowStockCount: 1 });
    expect(availabilityOf(3)).toEqual({ availability: 'low', lowStockCount: 3 });
    expect(availabilityOf(4)).toEqual({ availability: 'ok', lowStockCount: null });
    expect(availabilityOf(250)).toEqual({ availability: 'ok', lowStockCount: null });
  });
});
