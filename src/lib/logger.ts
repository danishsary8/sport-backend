import { pino, type Logger } from 'pino';
import type { Config } from '../config.js';

export type { Logger };

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
];

export function createLogger(config: Pick<Config, 'logLevel' | 'nodeEnv'>): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'sport-castle-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
