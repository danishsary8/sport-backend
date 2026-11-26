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

/**
 * The most a shopper may learn about a count: exact when 0–3 are left (what "Only 2 left" already shows),
 * otherwise nothing (null). Spec: customers only ever see ok, low (1–3) or out.
 */
export function publicCount(units: number): number | null {
  if (units <= 0) return 0;
  return units <= LOW_STOCK_MAX ? units : null;
}

/** Quantity cap for steppers: the real count when low, otherwise the generic line limit. */
export function publicMaxQty(units: number, lineLimit: number): number {
  return publicCount(units) ?? lineLimit;
}
