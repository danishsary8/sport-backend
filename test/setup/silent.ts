import { pino } from 'pino';
import { loadConfig } from '../../src/config.js';

export const testConfig = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/sportcastle_test',
  CORS_ORIGINS: 'http://localhost:5173',
});

export const silentLogger = pino({ level: 'silent' });
