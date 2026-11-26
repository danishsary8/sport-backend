import { sql } from 'drizzle-orm';
import type { Exec } from '../../db/exec.js';
import { PAYMENT_METHODS, type Fulfillment, type PaymentMethod } from '../../db/schema/index.js';

export type PaymentMethodsEnabled = Record<PaymentMethod, boolean>;

const DEFAULTS: PaymentMethodsEnabled = { aba_khqr: true, card: true, acleda: false, wing: false, cash_on_pickup: false };

/**
 * Which payment methods the shop has switched on (setting `payment_methods_enabled`).
 * In cash-only mode (PAYMENT_METHODS_CASH_ONLY, no PayWay account) only cash on pickup is ever on.
 */
export async function paymentMethodsEnabled(db: Exec, cashOnly = false): Promise<PaymentMethodsEnabled> {
  if (cashOnly) return Object.fromEntries(PAYMENT_METHODS.map((m) => [m, m === 'cash_on_pickup'])) as PaymentMethodsEnabled;
  const r = await db.execute<{ value: Partial<PaymentMethodsEnabled> | null }>(sql`select value from settings where key = 'payment_methods_enabled'`);
  const stored = r.rows[0]?.value ?? {};
  return Object.fromEntries(PAYMENT_METHODS.map((m) => [m, typeof stored[m] === 'boolean' ? stored[m] : DEFAULTS[m]])) as PaymentMethodsEnabled;
}

/** Methods a customer may choose for this fulfillment, in display order. Cash is only for pickup. */
export function availablePaymentMethods(enabled: PaymentMethodsEnabled, fulfillment: Fulfillment): PaymentMethod[] {
  return PAYMENT_METHODS.filter((m) => enabled[m] && (m !== 'cash_on_pickup' || fulfillment === 'pickup'));
}

export async function settingNumber(db: Exec, key: string, field: string, fallback: number): Promise<number> {
  const r = await db.execute<{ n: number | null }>(sql`select (value->>${field})::int as n from settings where key = ${key}`);
  return r.rows[0]?.n ?? fallback;
}
