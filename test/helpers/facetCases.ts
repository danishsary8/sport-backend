import type { CatalogFilters } from '../../src/modules/catalog/listing.js';

/** Filter combinations whose facet output is pinned in test/fixtures/facets.json. */
export const FACET_CASES: Record<string, CatalogFilters> = {
  none: {},
  jerseys: { category: 'jerseys' },
  bootsNikeSize: { category: 'boots', brand: ['nike'], size: ['EU 42'] },
  priceAndStock: { priceMin: 3000, priceMax: 20000, inStockOnly: true },
  searchAndDiscount: { q: 'madrid', discount: '1' },
  search: { q: 'nike' },
  colors: { color: ['black'] },
  tagsAndLeague: { tag: ['new', 'sale'], league: ['Premier League'] },
} as Record<string, CatalogFilters>;
