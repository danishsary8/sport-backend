import { z } from 'zod';

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).url('DATABASE_URL must be a URL'),
    CORS_ORIGINS: csv,
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
    PUBLIC_BASE_URL: z.string().url('PUBLIC_BASE_URL must be a URL').optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.PUBLIC_BASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'PUBLIC_BASE_URL is required in production' });
    }
  });

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  corsOrigins: string[];
  logLevel: string;
  rateLimitPerMinute: number;
  publicBaseUrl: string;
}

/** Reads and validates the environment. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => {
        const key = i.path.join('.') || 'env';
        return i.message.includes(key) ? i.message : `${key}: ${i.message}`;
      }),
    );
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    corsOrigins: e.CORS_ORIGINS,
    logLevel: e.LOG_LEVEL,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    publicBaseUrl: e.PUBLIC_BASE_URL ?? `http://localhost:${e.PORT}`,
  };
}
