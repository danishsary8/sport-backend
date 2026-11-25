import { sql } from 'drizzle-orm';
import type { Exec } from '../../db/exec.js';
import type { RmaResolution } from '../../db/schema/index.js';
import { monthlyNumber } from '../orders/number.js';

export interface ReturnRules {
  exchangeDays: number;
  refundDays: number;
  /** Category slugs, garment types or slug words that can't be returned (hygiene). */
  nonReturnable: string[];
}

export const DEFAULT_RETURN_RULES: ReturnRules = { exchangeDays: 30, refundDays: 14, nonReturnable: ['socks', 'underwear'] };
const DAY_MS = 86_400_000;

export function daysSince(from: Date, now: Date): number {
  return Math.floor((now.getTime() - from.getTime()) / DAY_MS);
}

/** Exchange: up to exchangeDays after delivery/pickup; refund or store credit: up to refundDays. */
export function returnWindowOpen(resolution: RmaResolution, deliveredAt: Date, now: Date, rules: ReturnRules): boolean {
  const limit = resolution === 'size_exchange' ? rules.exchangeDays : rules.refundDays;
  return daysSince(deliveredAt, now) <= limit;
}

export function isNonReturnable(p: { categorySlug: string; productSlug: string; garmentType: string | null }, rules: ReturnRules): boolean {
  const blocked = new Set(rules.nonReturnable.map((x) => x.toLowerCase()));
  if (blocked.has(p.categorySlug.toLowerCase())) return true;
  if (p.garmentType && blocked.has(p.garmentType.toLowerCase())) return true;
  return p.productSlug.toLowerCase().split('-').some((word) => blocked.has(word));
}

/** The paid share of a line for `returnQty` of its units. Discounts are already inside the line total. */
export function refundForLine(lineTotalCents: number, itemQty: number, returnQty: number): number {
  return Math.round((lineTotalCents * returnQty) / itemQty);
}

export async function loadReturnRules(db: Exec): Promise<ReturnRules> {
  const r = await db.execute<{ value: Partial<ReturnRules> | null }>(sql`select value from settings where key = 'return_rules'`);
  const v = r.rows[0]?.value ?? {};
  return {
    exchangeDays: typeof v.exchangeDays === 'number' ? v.exchangeDays : DEFAULT_RETURN_RULES.exchangeDays,
    refundDays: typeof v.refundDays === 'number' ? v.refundDays : DEFAULT_RETURN_RULES.refundDays,
    nonReturnable: Array.isArray(v.nonReturnable) ? v.nonReturnable.map(String) : DEFAULT_RETURN_RULES.nonReturnable,
  };
}

export function newRmaNumber(now: Date): string {
  return monthlyNumber('RMA', now);
}
