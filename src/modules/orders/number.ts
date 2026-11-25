import { randomInt } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PHNOM_PENH_OFFSET_MS = 7 * 60 * 60 * 1000;

/** `<PREFIX>-YYMM-XXXXX`: month in Phnom Penh time + 5 random Crockford base32 characters (~25 bits per month). */
export function monthlyNumber(prefix: string, now: Date, rand: (max: number) => number = randomInt): string {
  const local = new Date(now.getTime() + PHNOM_PENH_OFFSET_MS);
  const yy = String(local.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(local.getUTCMonth() + 1).padStart(2, '0');
  let suffix = '';
  for (let i = 0; i < 5; i++) suffix += CROCKFORD[rand(CROCKFORD.length)];
  return `${prefix}-${yy}${mm}-${suffix}`;
}

export function newOrderNumber(now: Date, rand: (max: number) => number = randomInt): string {
  return monthlyNumber('SC', now, rand);
}

/** PayWay tran_id: max 20 chars of [A-Za-z0-9-]; the order number without dashes, then the attempt. */
export function tranIdFor(number: string, attempt: number): string {
  return `${number.replaceAll('-', '')}-${attempt}`;
}
