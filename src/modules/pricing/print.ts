import { z } from 'zod';

export const PATCH_IDS = ['none', 'ucl', 'cpl', 'aff', 'champions', 'f1-paddock'] as const;
export const FONT_IDS = ['pro-condensed', 'classic-block', 'motorsport-aero'] as const;
export type PatchId = (typeof PATCH_IDS)[number];
export type FontId = (typeof FONT_IDS)[number];

export interface CustomPrint {
  name: string;
  number: number;
  patch: PatchId;
  font: FontId;
}

export interface PrintFees {
  baseCents: number;
  patches: Record<string, number>;
}

/** Same limits customers already see in the storefront's printing studio. */
export const customPrintSchema = z.object({
  name: z
    .string()
    .transform((v) => v.trim().replace(/\s+/g, ' ').toUpperCase())
    .pipe(
      z
        .string()
        .min(1, 'Enter a name to print')
        .max(14, 'Names can be up to 14 characters')
        .regex(/^[A-Z0-9 .'-]+$/, "Use letters A–Z, numbers, spaces, . ' and -"),
    ),
  number: z.number().int().min(1).max(99),
  patch: z.enum(PATCH_IDS),
  font: z.enum(FONT_IDS).default('pro-condensed'),
});

/** Identifies identical prints so the same jersey with the same print is one cart line. */
export function printKey(p: CustomPrint | null): string {
  return p ? `${p.name}|${p.number}|${p.patch}|${p.font}` : '';
}

export function printFeeCents(p: CustomPrint | null, fees: PrintFees, freePrinting: boolean): number {
  if (!p || freePrinting) return 0;
  return fees.baseCents + (fees.patches[p.patch] ?? 0);
}
