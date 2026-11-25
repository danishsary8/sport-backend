import { z } from 'zod';

/** Shared building blocks of the public API contract. Money is always integer cents (USD). */
export const cents = z.number().int();
export const isoDate = z.string().datetime({ offset: true });
export const availability = z.enum(['ok', 'low', 'out']);
export const i18n = z.strictObject({ en: z.string(), km: z.string().optional() });
export const lang = z.enum(['en', 'km']);

export const errorBody = z.strictObject({
  error: z.strictObject({ code: z.string(), message: z.string(), details: z.unknown().optional(), requestId: z.string().optional() }),
});

export const paged = { total: z.number().int(), page: z.number().int(), pageSize: z.number().int() };
