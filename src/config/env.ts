import { z } from 'zod';
import { normalizePhone } from '../lib/phone.js';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  corsOrigins: string[];
  cookieSecret: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  firebaseProjectId: string | undefined;
  firebaseServiceAccount: Record<string, unknown> | undefined;
  bootstrapAdminPhones: string[];
  bootstrapAdminEmails: string[];
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
    if (env.NODE_ENV === 'production' && /change-me/i.test(env.COOKIE_SECRET)) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECRET'],
        message: 'is still the .env.example placeholder; generate a random secret',
      });
    }
  });

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
    corsOrigins: e.CORS_ORIGINS,
    cookieSecret: e.COOKIE_SECRET,
    logLevel: e.LOG_LEVEL,
    firebaseProjectId: e.FIREBASE_PROJECT_ID,
    firebaseServiceAccount: e.FIREBASE_SERVICE_ACCOUNT_JSON,
    bootstrapAdminPhones: e.BOOTSTRAP_ADMIN_PHONES,
    bootstrapAdminEmails: e.BOOTSTRAP_ADMIN_EMAILS,
  };
}
