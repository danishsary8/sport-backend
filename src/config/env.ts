import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { normalizePhone } from '../lib/phone.js';

/** This API's public address: PUBLIC_API_URL, else Render's own external URL, else the local default. */
function publicApiUrlOf(e: { PUBLIC_API_URL?: string; RENDER_EXTERNAL_URL?: string }): string {
  return (e.PUBLIC_API_URL ?? e.RENDER_EXTERNAL_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

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
  /** Bakong KHQR (used when PayWay is not configured); undefined when its settings are not set. */
  bakong: BakongSettings | undefined;
  /** Production may run without an online payment service only when the shop takes cash on pickup alone. */
  paymentsCashOnly: boolean;
  /** This API's public base URL (dev payment pages link back to it). */
  publicApiUrl: string;
  telegramBotToken: string | undefined;
  telegramChatId: string | undefined;
  resendApiKey: string | undefined;
  /** Turns on smart search (Claude reads the shopper's words). Off when unset. */
  anthropicApiKey: string | undefined;
  notificationFromEmail: string | undefined;
  /** How many reverse proxies sit in front of the API (load balancer = 1; CDN + load balancer = 2). */
  trustProxyHops: number;
  /** Runs the per-minute sweeper (payments, expiry, notifications). */
  jobsEnabled: boolean;
  /** Test sign-in tokens instead of Firebase (end-to-end tests). Refused in production. */
  authTestMode: boolean;
}

export interface BakongSettings {
  token: string;
  accountId: string;
  merchantName: string;
  merchantCity: string;
  apiUrl: string;
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
    PAYWAY_BASE_URL: optionalText.pipe(z.string().url().optional()),
    PAYWAY_RETURN_URL: optionalText.pipe(z.string().url().optional()),
    PAYWAY_CONTINUE_URL: optionalText.pipe(z.string().url().optional()),
    PAYMENT_METHODS_CASH_ONLY: booleanText,
    BAKONG_TOKEN: optionalText,
    BAKONG_ACCOUNT_ID: optionalText.pipe(z.string().regex(/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/, 'must look like name@bank, e.g. sportcastle@aba').max(32).optional()),
    BAKONG_MERCHANT_NAME: optionalText.pipe(z.string().regex(/^[\x20-\x7E]+$/, 'must be plain English letters, numbers and spaces').max(25).optional()),
    BAKONG_MERCHANT_CITY: optionalText.pipe(z.string().regex(/^[\x20-\x7E]+$/, 'must be plain English letters, numbers and spaces').max(15).optional()),
    BAKONG_API_URL: optionalText.pipe(z.string().url().optional()),
    PUBLIC_API_URL: z.string().trim().url().optional(),
    /** Set by Render on every service: used when PUBLIC_API_URL is not set. */
    RENDER_EXTERNAL_URL: z.string().trim().url().optional(),
    TELEGRAM_BOT_TOKEN: optionalText,
    TELEGRAM_CHAT_ID: optionalText,
    RESEND_API_KEY: optionalText,
    ANTHROPIC_API_KEY: optionalText,
    NOTIFICATION_FROM_EMAIL: optionalText,
    JOBS_ENABLED: booleanText,
    TRUST_PROXY_HOPS: z.string().optional().transform((v) => (v ? Number(v) : 1)).pipe(z.number().int().min(0).max(5)),
    AUTH_TEST_MODE: booleanText,
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
    // Uploaded product photos are served from this address, so it must be the API's real public URL.
    if (env.NODE_ENV === 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(publicApiUrlOf(env))) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_API_URL'], message: "must be this API's public address in production (uploaded photos are served from it)" });
    }
    if (env.NODE_ENV === 'production' && env.AUTH_TEST_MODE) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_TEST_MODE'], message: 'must not be enabled in production' });
    }
    if ((env.PAYWAY_MERCHANT_ID === undefined) !== (env.PAYWAY_API_KEY === undefined)) {
      const missing = env.PAYWAY_MERCHANT_ID === undefined ? 'PAYWAY_MERCHANT_ID' : 'PAYWAY_API_KEY';
      ctx.addIssue({ code: 'custom', path: [missing], message: 'PAYWAY_MERCHANT_ID and PAYWAY_API_KEY must be set together' });
    }
    const bakongKeys = ['BAKONG_TOKEN', 'BAKONG_ACCOUNT_ID', 'BAKONG_MERCHANT_NAME'] as const;
    const bakongSet = bakongKeys.filter((k) => env[k] !== undefined);
    if (bakongSet.length > 0 && bakongSet.length < bakongKeys.length) {
      for (const key of bakongKeys.filter((k) => env[k] === undefined)) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${bakongKeys.join(', ')} must be set together` });
      }
    }
    // Production takes online payments through PayWay or Bakong, or runs cash-only.
    if (env.NODE_ENV === 'production' && !env.PAYMENT_METHODS_CASH_ONLY && bakongSet.length < bakongKeys.length) {
      for (const key of ['PAYWAY_MERCHANT_ID', 'PAYWAY_API_KEY', 'PAYWAY_RETURN_URL', 'PAYWAY_CONTINUE_URL'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required in production (or set up Bakong with BAKONG_TOKEN, BAKONG_ACCOUNT_ID and BAKONG_MERCHANT_NAME, or set PAYMENT_METHODS_CASH_ONLY=true)' });
        }
      }
    }
    if (env.NODE_ENV === 'production' && env.PAYWAY_MERCHANT_ID && env.PAYWAY_BASE_URL === undefined) {
      ctx.addIssue({ code: 'custom', path: ['PAYWAY_BASE_URL'], message: 'must be set in production (https://checkout.payway.com.kh, or the sandbox URL on a test server)' });
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
    paywayBaseUrl: (e.PAYWAY_BASE_URL ?? 'https://checkout-sandbox.payway.com.kh').replace(/\/+$/, ''),
    paywayReturnUrl: e.PAYWAY_RETURN_URL,
    paywayContinueUrl: e.PAYWAY_CONTINUE_URL,
    bakong:
      e.BAKONG_TOKEN && e.BAKONG_ACCOUNT_ID && e.BAKONG_MERCHANT_NAME
        ? {
            token: e.BAKONG_TOKEN,
            accountId: e.BAKONG_ACCOUNT_ID,
            merchantName: e.BAKONG_MERCHANT_NAME,
            merchantCity: e.BAKONG_MERCHANT_CITY ?? 'Phnom Penh',
            apiUrl: (e.BAKONG_API_URL ?? 'https://api-bakong.nbc.gov.kh').replace(/\/+$/, ''),
          }
        : undefined,
    paymentsCashOnly: e.PAYMENT_METHODS_CASH_ONLY ?? false,
    publicApiUrl: publicApiUrlOf(e),
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChatId: e.TELEGRAM_CHAT_ID,
    resendApiKey: e.RESEND_API_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    notificationFromEmail: e.NOTIFICATION_FROM_EMAIL,
    jobsEnabled: e.JOBS_ENABLED ?? true,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    authTestMode: e.AUTH_TEST_MODE ?? false,
  };
}
