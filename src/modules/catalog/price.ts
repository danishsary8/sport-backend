import { eq } from 'drizzle-orm';
import type { Exec } from '../../db/exec.js';
import { settings } from '../../db/schema/index.js';

/**
 * Shop prices always end in .90. A price that doesn't is moved down to the .90 just below it
 * ($12.00 and $12.50 become $11.90); nothing goes below $0.90. "Was" prices are left as they are.
 */
export function toNinety(cents: number): number {
  if (cents <= 90) return 90;
  return Math.floor((cents - 90) / 100) * 100 + 90;
}

/** Whether the shop rounds prices to .90 (setting price_rounding; on unless an admin turned it off). */
export async function priceRounder(db: Exec): Promise<(cents: number) => number> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'price_rounding'));
  const on = (row?.value as { endInNinety?: unknown } | undefined)?.endInNinety !== false;
  return on ? toNinety : (cents) => cents;
}
