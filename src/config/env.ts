import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { normalizePhone } from '../lib/phone.js';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  /** PEM of the CA that signed the database certificate (managed Postgres with a private CA). */
  databaseSslCa: string | undefined;
  corsOrigins: string[];
  cookieSecret: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  firebaseProjectId: string | undefined;
  firebaseServiceAccount: Record<string, unknown> | undefined;
  bootstrapAdminPhones: string[];
  bootstrapAdminEmails: string[];
  /** Prefix for catalog image paths, e.g. https://cdn.example.com/ (default /assets/). */
  assetBaseUrl: string;
  /** ABA PayWay; when merchant id + key are missing the fake provider is used (never in production). */
  paywayMerchantId: string | undefined;
  paywayApiKey: string | undefined;
  paywayBaseUrl: string;
  /** Pushback (webhook) URL PayWay calls, e.g. https://api.example.com/v1/webhooks/payway. */
  paywayReturnUrl: string | undefined;
  /** Where the browser goes after a card payment, e.g. https://example.com/checkout/return. */
  paywayContinueUrl: string | undefined;
  /** Production may run without PayWay only when the shop takes cash on pickup alone. */
  paymentsCashOnly: boolean;
  /** This API's public base URL (dev payment pages link back to it). */
  publicApiUrl: string;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  resendApiKey: string | undefined;
  notificationFromEmail: string | undefined;
  /** Runs the per-minute sweeper (payments, expiry, notifications). */
  jobsEnabled: boolean;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

const booleanText = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

/** Comma-separated list → trimmed, mapped values. */
function listOf(map: (value: string, ctx: z.RefinementCtx) => string) {
  return optionalText.transform((v, ctx) =>
    v
      ? v
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => map(item, ctx))
      : [],
  );
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z
      .string()
      .optional()
      .transform((v) => (v === undefined || v === '' ? 3000 : Number(v)))
      .pipe(z.number().int().min(0).max(65535, 'must be a port number')),
    DATABASE_URL: z.string({ error: 'is required' }).trim().min(1, 'is required'),
    DATABASE_SSL: booleanText,
    DATABASE_SSL_CA: optionalText,
    CORS_ORIGINS: optionalText.transform((v) =>
      v
        ? v
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean)
        : [],
    ),
    COOKIE_SECRET: z
      .string({ error: 'is required' })
      .min(32, 'must be at least 32 characters'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    FIREBASE_PROJECT_ID: optionalText,
    FIREBASE_SERVICE_ACCOUNT_JSON: optionalText.transform((v, ctx) => {
      if (v === undefined) return undefined;
      try {
        const parsed: unknown = JSON.parse(v);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // fall through
      }
      ctx.addIssue({ code: 'custom', message: 'must be the service account JSON object' });
      return z.NEVER;
    }),
    BOOTSTRAP_ADMIN_PHONES: listOf((value, ctx) => {
      const phone = normalizePhone(value);
      if (!phone) ctx.addIssue({ code: 'custom', message: `"${value}" is not a valid phone number` });
      return phone ?? '';
    }),
    BOOTSTRAP_ADMIN_EMAILS: listOf((value) => value.toLowerCase()),
    ASSET_BASE_URL: z.string().trim().max(300).default('/assets/'),
    PAYWAY_MERCHANT_ID: optionalText,
    PAYWAY_API_KEY: optionalText,
    PAYWAY_BASE_URL: z.string().trim().url().default('https://checkout-sandbox.payway.com.kh'),
    PAYWAY_RETURN_URL: optionalText.pipe(z.string().url().optional()),
    PAYWAY_CONTINUE_URL: optionalText.pipe(z.string().url().optional()),
    PAYMENT_METHODS_CASH_ONLY: booleanText,
    PUBLIC_API_URL: z.string().trim().url().default('http://localhost:3000'),
    TELEGRAM_BOT_TOKEN: optionalText,
    TELEGRAM_CHAT_ID: optionalText,
    RESEND_API_KEY: optionalText,
    NOTIFICATION_FROM_EMAIL: optionalText,
    JOBS_ENABLED: booleanText,
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'must list at least one origin in production',
      });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of ['FIREBASE_PROJECT_ID', 'FIREBASE_SERVICE_ACCOUNT_JSON'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production' });
        }
      }
    }
    if ((env.PAYWAY_MERCHANT_ID === undefined) !== (env.PAYWAY_API_KEY === undefined)) {
      const missing = env.PAYWAY_MERCHANT_ID === undefined ? 'PAYWAY_MERCHANT_ID' : 'PAYWAY_API_KEY';
      ctx.addIssue({ code: 'custom', path: [missing], message: 'PAYWAY_MERCHANT_ID and PAYWAY_API_KEY must be set together' });
    }
    if (env.NODE_ENV === 'production' && !env.PAYMENT_METHODS_CASH_ONLY) {
      for (const key of ['PAYWAY_MERCHANT_ID', 'PAYWAY_API_KEY', 'PAYWAY_RETURN_URL', 'PAYWAY_CONTINUE_URL'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production (or set PAYMENT_METHODS_CASH_ONLY=true)' });
        }
      }
    }
    if (env.NODE_ENV === 'production' && /change-me/i.test(env.COOKIE_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECRET'],
        message: 'is still the .env.example placeholder; generate a random secret',
      });
    }
  });

/** DATABASE_SSL_CA holds the PEM itself, or a file path when it starts with '/'. */
function loadCa(value: string): string {
  return value.startsWith('/') ? readFileSync(value, 'utf8') : value.replace(/\\n/g, '\n');
}

/** Validates environment variables; throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // `KEY=` lines (as in .env.example) arrive as '' — treat them as unset so defaults apply.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL ?? e.NODE_ENV === 'production',
    databaseSslCa: e.DATABASE_SSL_CA ? loadCa(e.DATABASE_SSL_CA) : undefined,
    corsOrigins: e.CORS_ORIGINS,
    cookieSecret: e.COOKIE_SECRET,
    logLevel: e.LOG_LEVEL,
    firebaseProjectId: e.FIREBASE_PROJECT_ID,
    firebaseServiceAccount: e.FIREBASE_SERVICE_ACCOUNT_JSON,
    bootstrapAdminPhones: e.BOOTSTRAP_ADMIN_PHONES,
    bootstrapAdminEmails: e.BOOTSTRAP_ADMIN_EMAILS,
    assetBaseUrl: e.ASSET_BASE_URL,
    paywayMerchantId: e.PAYWAY_MERCHANT_ID,
    paywayApiKey: e.PAYWAY_API_KEY,
    paywayBaseUrl: e.PAYWAY_BASE_URL.replace(/\/+$/, ''),
    paywayReturnUrl: e.PAYWAY_RETURN_URL,
    paywayContinueUrl: e.PAYWAY_CONTINUE_URL,
    paymentsCashOnly: e.PAYMENT_METHODS_CASH_ONLY ?? false,
    publicApiUrl: e.PUBLIC_API_URL.replace(/\/+$/, ''),
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChatId: e.TELEGRAM_CHAT_ID,
    resendApiKey: e.RESEND_API_KEY,
    notificationFromEmail: e.NOTIFICATION_FROM_EMAIL,
    jobsEnabled: e.JOBS_ENABLED ?? true,
  };
}
