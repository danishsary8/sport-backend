import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { payments, type PaymentRow } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';
import { applyProviderResult, type ConfirmSource } from './confirm.js';
import type { PaymentProvider } from './provider.js';

/**
 * Asks the provider about a pending payment, at most once per interval across every caller and instance
 * (the last_checked_at claim is atomic). Provider outages are swallowed: the caller just sees "pending".
 */
export async function refreshPayment(
  deps: { db: Db; payments: PaymentProvider; now: () => Date },
  payment: PaymentRow,
  opts: { minIntervalMs?: number; source?: ConfirmSource } = {},
): Promise<PaymentRow> {
  const now = deps.now();
  const minInterval = opts.minIntervalMs ?? 5_000;
  const claimed = await deps.db
    .update(payments)
    .set({ lastCheckedAt: now })
    .where(
      and(
        eq(payments.id, payment.id),
        eq(payments.status, 'pending'),
        or(isNull(payments.lastCheckedAt), lt(payments.lastCheckedAt, new Date(now.getTime() - minInterval))),
      ),
    )
    .returning({ id: payments.id });
  if (claimed.length > 0) {
    try {
      const check = await deps.payments.checkTransaction(payment.providerTranId);
      await applyProviderResult(deps, payment.providerTranId, check, opts.source ?? 'poll');
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }
  const [fresh] = await deps.db.select().from(payments).where(eq(payments.id, payment.id));
  return fresh ?? payment;
}
