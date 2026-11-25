import { z } from 'zod';
import type { I18n } from '../../db/schema/index.js';

export const LANGS = ['en', 'km'] as const;
export type Lang = (typeof LANGS)[number];
export const langSchema = z.enum(LANGS).default('en');

export function pick(value: I18n | null | undefined, lang: Lang): string | null {
  if (!value) return null;
  return (lang === 'km' ? value.km : undefined) ?? value.en;
}
