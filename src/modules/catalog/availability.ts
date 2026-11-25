export type Availability = 'ok' | 'low' | 'out';

/** Units sellable online: per branch, what is left after reservations and the safety buffer. */
export function onlineAvailable(rows: { onHand: number; reserved: number; buffer: number }[]): number {
  return rows.reduce((sum, r) => sum + Math.max(0, r.onHand - r.reserved - r.buffer), 0);
}

export const LOW_STOCK_MAX = 3;

/** Public availability. Exact counts are only revealed when low (1–3) — never larger numbers. */
export function availabilityOf(units: number): { availability: Availability; lowStockCount: number | null } {
  if (units <= 0) return { availability: 'out', lowStockCount: null };
  if (units <= LOW_STOCK_MAX) return { availability: 'low', lowStockCount: units };
  return { availability: 'ok', lowStockCount: null };
}
