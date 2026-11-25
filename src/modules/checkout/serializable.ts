import type { Db } from '../../db/client.js';
import type { Tx } from '../../db/exec.js';

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

/** Runs fn in a SERIALIZABLE transaction, retrying serialization failures and deadlocks. */
export async function withSerializable<T>(db: Db, fn: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(fn, { isolationLevel: 'serializable' });
    } catch (error) {
      const code = pgCode(error);
      if (!code || !RETRYABLE.has(code) || attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * attempt));
    }
  }
}
