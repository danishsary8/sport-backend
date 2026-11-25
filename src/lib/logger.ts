import { pino } from 'pino';
import type { Config } from '../config/env.js';

export type Logger = pino.Logger;

/** '+85512345678' → '***678'. Keeps logs useful for support without storing full numbers. */
export function redactPhone(value: string): string {
  const digits = String(value).replace(/\D/g, '');
  return `***${digits.slice(-3)}`;
}

const PHONE_KEY = /phone/i;
const MAX_DEPTH = 8;

/** Returns a copy of `value` with every string under a key containing "phone" masked, at any depth. */
function maskPhones(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((item) => maskPhones(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] =
      PHONE_KEY.test(key) && typeof inner === 'string' ? redactPhone(inner) : maskPhones(inner, depth + 1);
  }
  return out;
}

const SECRET_PATHS = ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'];

export function createLogger(
  cfg: Pick<Config, 'logLevel' | 'nodeEnv'>,
  destination?: pino.DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level: cfg.logLevel,
    base: { service: 'sport-backend' },
    redact: { paths: SECRET_PATHS, censor: '[redacted]' },
    formatters: {
      log: (object) => maskPhones(object) as Record<string, unknown>,
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
