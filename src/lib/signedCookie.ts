import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

const mac = (value: string, secret: string) => createHmac('sha256', secret).update(value).digest('base64url');

export function sign(value: string, secret: string): string {
  return `${value}.${mac(value, secret)}`;
}

/** Returns the original value, or null if the signature doesn't match. */
export function verify(signed: string, secret: string): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(mac(value, secret));
  return given.length === expected.length && timingSafeEqual(given, expected) ? value : null;
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
