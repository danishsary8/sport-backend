import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { CONTINENTS, continentSql, seasonSql } from '../catalog/derived.js';

/**
 * Smart search: a shopper's own words ("nike turf boots under $100", Khmer too) become catalogue filters.
 * Claude reads the words with the shop's real vocabulary and answers in a fixed JSON shape; only values the shop
 * really has are kept, so a made-up brand or league can never reach the listing. Answers are cached per query.
 */

export interface SearchVocab {
  categories: { slug: string; name: string }[];
  brands: { slug: string; name: string }[];
  leagues: string[];
  seasons: string[];
  continents: string[];
  kitTypes: string[];
  surfaces: string[];
}

/** What the model answers (prices in dollars, as people say them). */
export const modelAnswer = z.object({
  category: z.string().nullable().describe('One category slug from the list, or null'),
  brand: z.array(z.string()).describe('Brand slugs from the list'),
  league: z.array(z.string()).describe('Leagues from the list; "International" means national teams'),
  season: z.array(z.string()).describe('Seasons from the list, e.g. "2026/27"'),
  continent: z.array(z.string()).describe('Continent values from the list (national teams only)'),
  kitType: z.array(z.string()).describe('Kit types from the list'),
  surface: z.array(z.string()).describe('Boot surfaces from the list'),
  priceMin: z.number().nullable().describe('Lowest price in US dollars, or null'),
  priceMax: z.number().nullable().describe('Highest price in US dollars, or null'),
  keywords: z.string().describe('Remaining words to search for in product names (team, player, colour), in English, or empty'),
});
export type ModelAnswer = Partial<z.infer<typeof modelAnswer>>;

/** Clean filters, ready for /v1/catalog/products (prices in cents). Empty parts are left out. */
export interface SmartFilters {
  category?: string;
  brand?: string[];
  league?: string[];
  season?: string[];
  continent?: string[];
  kitType?: string[];
  surface?: string[];
  priceMinCents?: number;
  priceMaxCents?: number;
  q?: string;
}

/** Sends the system prompt and the shopper's words to the model; returns its answer. */
export type AskModel = (system: string, user: string) => Promise<ModelAnswer>;
export type SmartSearch = (q: string, lang: 'en' | 'km', vocab: SearchVocab) => Promise<SmartFilters | null>;

/** Keeps only values in the shop's vocabulary; never trusts the model's spelling of a value. */
export function cleanFilters(a: ModelAnswer, v: SearchVocab): SmartFilters {
  const keep = (values: string[] | undefined, allowed: string[]) => {
    const byLower = new Map(allowed.map((x) => [x.toLowerCase(), x]));
    const out = [...new Set((values ?? []).map((x) => byLower.get(String(x).trim().toLowerCase())).filter((x): x is string => !!x))];
    return out.length ? out : undefined;
  };
  const cents = (d: number | null | undefined) => (typeof d === 'number' && Number.isFinite(d) && d > 0 && d < 100_000 ? Math.round(d * 100) : undefined);
  const out: SmartFilters = {
    category: v.categories.find((c) => c.slug === a.category)?.slug,
    brand: keep(a.brand, v.brands.map((b) => b.slug)),
    league: keep(a.league, v.leagues),
    season: keep(a.season, v.seasons),
    continent: keep(a.continent, v.continents),
    kitType: keep(a.kitType, v.kitTypes),
    surface: keep(a.surface, v.surfaces),
    priceMinCents: cents(a.priceMin),
    priceMaxCents: cents(a.priceMax),
    q: a.keywords?.trim().slice(0, 100) || undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, x]) => x !== undefined)) as SmartFilters;
}

function systemPrompt(v: SearchVocab): string {
  const list = (xs: string[]) => (xs.length ? xs.join(' | ') : '(none)');
  return [
    'You turn a shopper\'s search in a football shop (English or Khmer) into catalogue filters.',
    'Use only values from these lists, exactly as written. Leave a filter empty when the words do not ask for it.',
    `Categories (slug = name): ${v.categories.map((c) => `${c.slug} = ${c.name}`).join('; ')}`,
    `Brands (slug = name): ${v.brands.map((b) => `${b.slug} = ${b.name}`).join('; ')}`,
    `Leagues: ${list(v.leagues)} ("International" = national teams)`,
    `Seasons: ${list(v.seasons)}`,
    `Continents (national teams only): ${list(v.continents)}`,
    `Kit types: ${list(v.kitTypes)}`,
    `Boot surfaces: ${list(v.surfaces)} (FG firm ground, AG artificial grass, TF turf, IC indoor, MG multi-ground)`,
    'Prices are in US dollars. "under 100" means priceMax 100.',
    'Put the remaining useful words (a club, a player, a country, a colour, a model name) in keywords, translated to English, without words already covered by a filter. Do not add words the shopper did not mean.',
  ].join('\n');
}

const normalise = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();

/** Smart search with an answer cache (per language and query; 1 hour, at most 500 entries). */
export function createSmartSearch(ask: AskModel, opts: { ttlMs?: number; maxEntries?: number; onError?: (error: unknown) => void } = {}): SmartSearch {
  const ttl = opts.ttlMs ?? 60 * 60_000;
  const max = opts.maxEntries ?? 500;
  const cache = new Map<string, { at: number; filters: SmartFilters }>();
  return async (q, lang, vocab) => {
    const words = normalise(q);
    const key = `${lang}:${words}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.filters;
    try {
      const filters = cleanFilters(await ask(systemPrompt(vocab), words), vocab);
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
      cache.set(key, { at: Date.now(), filters });
      return filters;
    } catch (error) {
      opts.onError?.(error);
      return null;
    }
  };
}

/**
 * The real model call: Claude Opus 5.5 at low effort (a short classification), structured JSON output, and the
 * server-side refusal fallback so a declined request is answered by another model instead of failing.
 */
export function claudeAsk(client: Anthropic): AskModel {
  return async (system, user) => {
    const response = await client.beta.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(modelAnswer) },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal' || !response.parsed_output) throw new Error(`No filters (${response.stop_reason})`);
    return response.parsed_output;
  };
}

/** The shop's current vocabulary: categories, brands and the sub-types active products have. */
export async function loadVocab(db: Db, lang: 'en' | 'km'): Promise<SearchVocab> {
  const [cats, brands, attrs] = await Promise.all([
    db.execute<{ slug: string; name: string }>(sql`select slug, coalesce(name_i18n->>${lang}, name_i18n->>'en') as name from categories order by sort`),
    db.execute<{ slug: string; name: string }>(sql`select distinct b.slug, b.name from brands b join products p on p.brand_id = b.id where p.status = 'active' order by b.name`),
    db.execute<{ league: string | null; season: string | null; continent: string | null; kit: string | null; surface: string | null }>(sql`
      select distinct p.attributes->>'league' as league, ${seasonSql} as season, ${continentSql} as continent,
        p.attributes->>'kitType' as kit, p.attributes->>'surface' as surface
      from products p where p.status = 'active'`),
  ]);
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  return {
    categories: cats.rows,
    brands: brands.rows,
    leagues: uniq(attrs.rows.map((r) => r.league)),
    seasons: uniq(attrs.rows.map((r) => r.season)).reverse(),
    continents: CONTINENTS.map((c) => c.value).filter((c) => attrs.rows.some((r) => r.continent === c)),
    kitTypes: uniq(attrs.rows.map((r) => r.kit)),
    surfaces: uniq(attrs.rows.map((r) => r.surface)),
  };
}
