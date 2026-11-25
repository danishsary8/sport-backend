import { createHash } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { idempotencyKeys } from '../../db/schema/index.js';
import { AppError } from '../../lib/errors.js';

const IN_PROGRESS_MS = 60_000;

/** Canonical JSON (sorted keys) hashed, so the same request always gets the same fingerprint. */
export function requestHash(body: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)]))
        : v;
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

/**
 * Runs fn once per (scope, key). A replay with the same request returns the stored response; a different
 * request with the same key is refused. Only successful responses are stored: after an error the key is
 * released so the customer can fix the problem and retry with it.
 */
export async function withIdempotency(
  db: Db,
  scope: string,
  key: string,
  hash: string,
  fn: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }> {
  const claimed = await db.insert(idempotencyKeys).values({ scope, key, requestHash: hash }).onConflictDoNothing().returning({ createdAt: idempotencyKeys.createdAt });
  let claimAt = claimed[0]?.createdAt;
  if (claimed.length === 0) {
    const [row] = await db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
    if (!row) return withIdempotency(db, scope, key, hash, fn);
    if (row.requestHash !== hash) {
      throw new AppError('idempotency_mismatch', 422, 'This Idempotency-Key was already used for a different request');
    }
    if (row.statusCode !== null) return { status: row.statusCode, body: row.response };
    // In flight elsewhere; take it over only if that attempt looks abandoned.
    const takeover = await db
      .update(idempotencyKeys)
      .set({ createdAt: sql`now()` })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), lt(idempotencyKeys.createdAt, new Date(Date.now() - IN_PROGRESS_MS))))
      .returning({ createdAt: idempotencyKeys.createdAt });
    if (takeover.length === 0) throw new AppError('request_in_progress', 409, 'This order is already being placed; please wait');
    claimAt = takeover[0]!.createdAt;
  }

  // Release only our own unfinished claim: a slow original that finished meanwhile keeps its result.
  const release = () =>
    db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), isNull(idempotencyKeys.statusCode), eq(idempotencyKeys.createdAt, claimAt!)));
  let result: { status: number; body: unknown };
  try {
    result = await fn();
  } catch (error) {
    await release();
    throw error;
  }
  if (result.status >= 200 && result.status < 300) {
    await db
      .update(idempotencyKeys)
      .set({ statusCode: result.status, response: result.body })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
  } else {
    await release();
  }
  return result;
}
