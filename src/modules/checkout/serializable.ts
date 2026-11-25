import type { Db } from '../../db/client.js';
import type { Tx } from '../../db/exec.js';
import { AppError } from '../../lib/errors.js';

const RETRYABLE = new Set(['40001', '40P01']);

export function pgCode(error: unknown): string | undefined {
  let e: unknown = error;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Runs fn in a SERIALIZABLE transaction, retrying serialization failures and deadlocks with exponential
 * backoff. When the retries run out the shopper gets a retryable 503, never a 500.
 */
export async function withSerializable<T>(db: Db, fn: (tx: Tx) => Promise<T>, attempts = 8, baseDelayMs = 15): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(fn, { isolationLevel: 'serializable' });
    } catch (error) {
      const code = pgCode(error);
      if (!code || !RETRYABLE.has(code)) throw error;
      if (attempt >= attempts) {
        throw new AppError('busy', 503, 'Lots of people are checking out right now. Please try again in a moment.');
      }
      const delay = Math.min(400, baseDelayMs * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, delay / 2 + Math.random() * delay));
    }
  }
}
