/** Readable SKU from slug + size, e.g. CAMBODIA-NATIONAL-TEAM-HOME-M. Callers de-duplicate. */
export function skuBase(slug: string, size: string): string {
  const prefix = slug.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 28).replace(/-+$/, '');
  const sizeCode = size.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'OS';
  return `${prefix}-${sizeCode}`;
}
