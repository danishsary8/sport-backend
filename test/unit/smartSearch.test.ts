import { describe, expect, it } from 'vitest';
import { cleanFilters, createSmartSearch, type SearchVocab } from '../../src/modules/search/smartSearch.js';

const VOCAB: SearchVocab = {
  categories: [{ slug: 'boots', name: 'Football Boots' }, { slug: 'jerseys', name: 'Jerseys & Kits' }],
  brands: [{ slug: 'nike', name: 'Nike' }, { slug: 'adidas', name: 'Adidas' }],
  leagues: ['Premier League', 'International'],
  seasons: ['2026/27', '2002'],
  continents: ['europe', 'south-america'],
  kitTypes: ['Home', 'Away'],
  surfaces: ['FG', 'TF'],
};

describe('cleanFilters', () => {
  it('keeps only values the shop really has, and drops empty parts', () => {
    expect(
      cleanFilters(
        { category: 'jerseys', brand: ['nike', 'puma'], league: ['Premier League', 'Made Up'], season: ['2026/27'], continent: [], kitType: ['Away'], surface: ['XX'], priceMax: 100, keywords: ' liverpool ' },
        VOCAB,
      ),
    ).toEqual({ category: 'jerseys', brand: ['nike'], league: ['Premier League'], season: ['2026/27'], kitType: ['Away'], priceMaxCents: 10000, q: 'liverpool' });
  });
  it('ignores an unknown category and nonsense prices', () => {
    expect(cleanFilters({ category: 'spaceships', priceMin: -5, priceMax: 0 }, VOCAB)).toEqual({});
  });
});

describe('createSmartSearch', () => {
  it('asks the model once per query (cached), with the shop vocabulary, and returns clean filters', async () => {
    const asked: { system: string; user: string }[] = [];
    const search = createSmartSearch(async (system, user) => {
      asked.push({ system, user });
      return { category: 'boots', brand: ['nike'], surface: ['TF'], priceMax: 100, keywords: '' };
    });
    const a = await search('nike turf boots under 100', 'en', VOCAB);
    const b = await search('  Nike turf boots UNDER 100 ', 'en', VOCAB);
    expect(a).toEqual({ category: 'boots', brand: ['nike'], surface: ['TF'], priceMaxCents: 10000 });
    expect(b).toEqual(a);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.system).toContain('Premier League');
    expect(asked[0]!.user).toBe('nike turf boots under 100');
  });
  it('returns null (plain search) when the model fails', async () => {
    const search = createSmartSearch(async () => {
      throw new Error('down');
    });
    expect(await search('red shirt', 'en', VOCAB)).toBeNull();
  });
});
