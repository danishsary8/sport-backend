import { createHmac, timingSafeEqual } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const mac = (number: string, exp: string, secret: string) => createHmac('sha256', secret).update(`order:${number}:${exp}`).digest('base64url');

/** A guest's proof of access to one order: `<exp>.<hmac>`, valid for 24 hours. */
export function signOrderToken(number: string, secret: string, now: Date, ttlMs = DAY_MS): string {
  const exp = String(now.getTime() + ttlMs);
  return `${Buffer.from(exp).toString('base64url')}.${mac(number, exp, secret)}`;
}

export function verifyOrderToken(token: string, number: string, secret: string, now: Date): boolean {
  const [expPart, sig] = token.split('.');
  if (!expPart || !sig) return false;
  const exp = Buffer.from(expPart, 'base64url').toString();
  if (!/^\d{13,}$/.test(exp) || Number(exp) <= now.getTime()) return false;
  const expected = Buffer.from(mac(number, exp, secret));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
