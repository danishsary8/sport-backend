/** Removes accents (é → e) so "Mbappe" and "Mbappé" match. Khmer script is left as it is. */
export function foldAccents(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

/** How a customer's search text is compared with products' search_text. */
export function searchNeedle(q: string): string {
  return foldAccents(q.toLowerCase()).replace(/\s+/g, ' ').trim();
}

/** Lower-cased, accent-free text the trigram index searches: names, brand, club, league, colour. */
export function buildSearchText(parts: (string | null | undefined)[]): string {
  return foldAccents(parts
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .join(' ')
    .toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
