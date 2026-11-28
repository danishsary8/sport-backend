/**
 * Shop prices always end in .90. A price that doesn't is moved down to the .90 just below it
 * ($12.00 and $12.50 become $11.90); nothing goes below $0.90. "Was" prices are left as they are.
 */
export function toNinety(cents: number): number {
  if (cents <= 90) return 90;
  return Math.floor((cents - 90) / 100) * 100 + 90;
}
