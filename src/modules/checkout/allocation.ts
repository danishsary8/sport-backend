export interface BranchAvailability {
  branchId: string;
  sort: number;
  available: number;
}

export interface AllocationLine {
  lineId: string;
  variantId: string;
  qty: number;
  branches: BranchAvailability[];
}

export interface Allocation {
  lineId: string;
  variantId: string;
  branchId: string;
  qty: number;
}

export type AllocationResult =
  | { ok: true; allocations: Allocation[] }
  | { ok: false; shortfalls: { lineId: string; variantId: string; requested: number; available: number }[] };

/**
 * Decides which branch each unit ships from. Lines of the same variant share one pool.
 * Pickup: only the chosen branch. Delivery: the branch with the most remaining units (ties → lowest sort),
 * splitting a line across branches when no single branch can cover it.
 */
export function planAllocations(
  lines: AllocationLine[],
  mode: { fulfillment: 'pickup'; branchId: string } | { fulfillment: 'delivery' },
): AllocationResult {
  const remaining = new Map<string, number>();
  const key = (variantId: string, branchId: string) => `${variantId}@${branchId}`;
  for (const line of lines) {
    for (const b of line.branches) {
      if (!remaining.has(key(line.variantId, b.branchId))) remaining.set(key(line.variantId, b.branchId), Math.max(0, b.available));
    }
  }

  const allocations: Allocation[] = [];
  const shortfalls: { lineId: string; variantId: string; requested: number; available: number }[] = [];
  for (const line of lines) {
    const candidates = line.branches.filter((b) => mode.fulfillment === 'delivery' || b.branchId === mode.branchId);
    const left = (b: BranchAvailability) => remaining.get(key(line.variantId, b.branchId)) ?? 0;
    const total = candidates.reduce((sum, b) => sum + left(b), 0);
    if (total < line.qty) {
      shortfalls.push({ lineId: line.lineId, variantId: line.variantId, requested: line.qty, available: total });
      continue;
    }
    let need = line.qty;
    while (need > 0) {
      const best = [...candidates].sort((a, b) => left(b) - left(a) || a.sort - b.sort)[0]!;
      const take = Math.min(need, left(best));
      remaining.set(key(line.variantId, best.branchId), left(best) - take);
      allocations.push({ lineId: line.lineId, variantId: line.variantId, branchId: best.branchId, qty: take });
      need -= take;
    }
  }
  return shortfalls.length > 0 ? { ok: false, shortfalls } : { ok: true, allocations };
}
