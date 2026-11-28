/**
 * Every product the shop sells is a Grade A replica. Product text must not claim otherwise: "Authentic",
 * "Official", "licensed" and import/release claims are reworded. "Official Size 5" (the ball size standard) stays.
 */
const RULES: [RegExp, string][] = [
  // Import / release / distribution claims in specs → the honest label.
  [/\b(?:(\d{4}(?:\/\d{2})?) )?(?:Authentic|Official)\b[^"\n]*?\b(?:Import|Release|Distribution|Outerwear)\b/g, '$1 Grade A Replica'],
  [/\bOfficial (La Liga|UEFA) Licensed FIFA Quality Pro Ball\b/g, '$1 match ball design'],
  [/\bOfficial (?:FFC )?licensed /gi, ''],
  [/\bSlim Player-Issue Authentic Fit\b/g, 'Slim Player Fit'],
  [/\(Varaman Official\)/g, '(Varaman)'],
  [/\bcompatible with official /gi, 'Compatible with '],
  // Any other "Authentic"/"Official" word (not the size standard).
  [/\b(?:[Aa]uthentic|[Oo]fficial(?:ly)?)\s+(?!Size\b|size\b)/g, ''],
];

/** Rewords one text; returns it unchanged when there is nothing to fix. */
export function rewordReplica(text: string): string {
  let out = text;
  for (const [re, by] of RULES) out = out.replace(re, by);
  if (out === text) return text;
  out = out.replace(/ {2,}/g, ' ').replace(/ +(?=[,.;:)])/g, '').trim();
  // A sentence that began with the removed word starts with a capital again.
  if (/^(?:Authentic|Official)\b/i.test(text.trim())) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}
