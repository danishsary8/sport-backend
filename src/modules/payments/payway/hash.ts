import { createHmac, timingSafeEqual } from 'node:crypto';

/** PayWay request hash: base64(HMAC-SHA512(values concatenated in the documented order, api key)). */
export function paywayHash(values: string[], apiKey: string): string {
  return createHmac('sha512', apiKey).update(values.join('')).digest('base64');
}

export function safeEqualB64(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
