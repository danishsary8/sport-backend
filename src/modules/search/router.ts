import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { validate } from '../../middleware/validate.js';
import { loadVocab, type SearchVocab } from './smartSearch.js';

/**
 * GET /v1/search/smart?q=&lang= -> { available, filters }. The shop sends a shopper's words here and opens the
 * listing with the filters it gets back. available: false (no API key) or filters: null (the model failed) means
 * "use plain search". Limited to 20 a minute per address, since each new query costs a model call.
 */
export function smartSearchRouter(ctx: AppContext): Router {
  const router = Router();
  const { db } = ctx.database;
  // The vocabulary changes only when products do; re-read it at most every 5 minutes per language.
  const vocabCache = new Map<string, { at: number; vocab: SearchVocab }>();
  const vocabFor = async (lang: 'en' | 'km') => {
    const hit = vocabCache.get(lang);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.vocab;
    const vocab = await loadVocab(db, lang);
    vocabCache.set(lang, { at: Date.now(), vocab });
    return vocab;
  };

  router.get(
    '/search/smart',
    ctx.routeLimit('smart-search', 20),
    validate({ query: z.object({ q: z.string().trim().min(2).max(100), lang: z.enum(['en', 'km']).default('en') }) }),
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      if (!ctx.smartSearch) return res.json({ available: false, filters: null });
      const { q, lang } = req.query as unknown as { q: string; lang: 'en' | 'km' };
      const filters = await ctx.smartSearch(q, lang, await vocabFor(lang));
      res.json({ available: true, filters });
    },
  );
  return router;
}
