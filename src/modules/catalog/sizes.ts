const LETTERS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

/** Sort key so sizes list in a natural order: EU numbers, then letters, then "Size N", then as given. */
export function sizeSort(label: string, position: number): number {
  const trimmed = label.trim();
  const eu = /^EU\s*(\d+(?:\.\d)?)$/i.exec(trimmed);
  if (eu) return Math.round(Number(eu[1]) * 10);
  const letter = LETTERS.indexOf(trimmed.toUpperCase());
  if (letter >= 0) return 1000 + letter;
  const numbered = /^Size\s*(\d+)$/i.exec(trimmed);
  if (numbered) return 2000 + Number(numbered[1]);
  return 9000 + position;
}
