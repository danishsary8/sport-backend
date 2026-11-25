import { pino } from 'pino';
import type { Config } from '../config/env.js';

export type Logger = pino.Logger;

/** '+85512345678' → '***678'. Keeps logs useful for support without storing full numbers. */
export function redactPhone(value: string): string {
  const digits = String(value).replace(/\D/g, '');
  return `***${digits.slice(-3)}`;
}

const PHONE_PATHS = ['*.phone', '*.phoneE164', '*.contact_phone_e164', '*.contactPhoneE164'];
const SECRET_PATHS = ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'];

export function createLogger(
  cfg: Pick<Config, 'logLevel' | 'nodeEnv'>,
  destination?: pino.DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level: cfg.logLevel,
    base: { service: 'sport-backend' },
    redact: {
      paths: [...SECRET_PATHS, ...PHONE_PATHS],
      censor: (value, path) =>
        PHONE_PATHS.some((p) => p.split('.').pop() === path[path.length - 1]) && typeof value === 'string'
          ? redactPhone(value)
          : '[redacted]',
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
