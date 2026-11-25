import { describe, expect, it } from 'vitest';
import { planAllocations, type BranchAvailability } from '../../src/modules/checkout/allocation.js';

const b = (sonthormuk: number, sensok: number, chomkadong = 0): BranchAvailability[] => [
  { branchId: 'sonthormuk', sort: 1, available: sonthormuk },
  { branchId: 'sensok', sort: 2, available: sensok },
  { branchId: 'chomkadong', sort: 3, available: chomkadong },
];

describe('planAllocations', () => {
  it('delivers from the branch with the most stock', () => {
    expect(planAllocations([{ lineId: 'l1', variantId: 'v1', qty: 3, branches: b(1, 5) }], { fulfillment: 'delivery' })).toEqual({
      ok: true,
      allocations: [{ lineId: 'l1', variantId: 'v1', branchId: 'sensok', qty: 3 }],
    });
  });

  it('splits a line across branches, most stock first', () => {
    const result = planAllocations([{ lineId: 'l1', variantId: 'v1', qty: 6, branches: b(2, 3, 2) }], { fulfillment: 'delivery' });
    expect(result).toEqual({
      ok: true,
      allocations: [
        { lineId: 'l1', variantId: 'v1', branchId: 'sensok', qty: 3 },
        { lineId: 'l1', variantId: 'v1', branchId: 'sonthormuk', qty: 2 },
        { lineId: 'l1', variantId: 'v1', branchId: 'chomkadong', qty: 1 },
      ],
    });
  });

  it('breaks ties towards Sonthormuk', () => {
    const result = planAllocations([{ lineId: 'l1', variantId: 'v1', qty: 1, branches: b(2, 2) }], { fulfillment: 'delivery' });
    expect(result).toEqual({ ok: true, allocations: [{ lineId: 'l1', variantId: 'v1', branchId: 'sonthormuk', qty: 1 }] });
  });

  it('shares one pool between lines of the same variant', () => {
    const branches = b(3, 0);
    const result = planAllocations(
      [
        { lineId: 'l1', variantId: 'v1', qty: 2, branches },
        { lineId: 'l2', variantId: 'v1', qty: 2, branches },
      ],
      { fulfillment: 'delivery' },
    );
    expect(result).toEqual({ ok: false, shortfalls: [{ lineId: 'l2', variantId: 'v1', requested: 2, available: 1 }] });
  });

  it('only uses the chosen branch for pickup', () => {
    const result = planAllocations([{ lineId: 'l1', variantId: 'v1', qty: 2, branches: b(10, 1) }], { fulfillment: 'pickup', branchId: 'sensok' });
    expect(result).toEqual({ ok: false, shortfalls: [{ lineId: 'l1', variantId: 'v1', requested: 2, available: 1 }] });
  });

  it('allocates pickup from the chosen branch', () => {
    const result = planAllocations([{ lineId: 'l1', variantId: 'v1', qty: 2, branches: b(10, 2) }], { fulfillment: 'pickup', branchId: 'sensok' });
    expect(result).toEqual({ ok: true, allocations: [{ lineId: 'l1', variantId: 'v1', branchId: 'sensok', qty: 2 }] });
  });

  it('accepts an empty order', () => {
    expect(planAllocations([], { fulfillment: 'delivery' })).toEqual({ ok: true, allocations: [] });
  });
});
