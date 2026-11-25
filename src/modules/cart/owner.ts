import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Config } from '../../config/env.js';
import { readCookie, sign, verify } from '../../lib/signedCookie.js';

export const CART_COOKIE = 'sc_cart';
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export type CartOwner = { kind: 'member'; userId: string } | { kind: 'guest'; token: string | null };

/** Who owns the cart for this request: the signed-in member, or the guest named by a valid cookie. */
export function cartOwner(req: Request, config: Pick<Config, 'cookieSecret'>): CartOwner {
  if (req.user) return { kind: 'member', userId: req.user.id };
  const raw = readCookie(req, CART_COOKIE);
  return { kind: 'guest', token: raw ? verify(raw, config.cookieSecret) : null };
}

export function newGuestToken(): string {
  return randomBytes(16).toString('base64url');
}

export function setCartCookie(res: Response, token: string, config: Pick<Config, 'cookieSecret' | 'nodeEnv'>): void {
  res.cookie(CART_COOKIE, sign(token, config.cookieSecret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
    maxAge: MAX_AGE_MS,
  });
}

export function clearCartCookie(res: Response, config: Pick<Config, 'nodeEnv'>): void {
  res.clearCookie(CART_COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', path: '/' });
}
