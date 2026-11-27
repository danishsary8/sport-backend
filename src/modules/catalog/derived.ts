import { sql, type SQL } from 'drizzle-orm';

/**
 * Values the shop works out for every product, so products added later (admin, CSV) are found too:
 * a national team's continent, and the season of a kit. Both are columns of the listing `base` CTE.
 */

/** Continents in menu order, with the countries (as written in product names) that belong to each. */
export const CONTINENTS: { value: string; label: string; countries: string[] }[] = [
  {
    value: 'europe',
    label: 'Europe',
    countries: ['england', 'france', 'germany', 'spain', 'italy', 'portugal', 'netherlands', 'holland', 'belgium', 'croatia', 'switzerland', 'denmark', 'sweden', 'norway', 'poland', 'scotland', 'wales', 'austria', 'czech', 'serbia', 'turkey', 'türkiye', 'ukraine', 'ireland', 'greece', 'hungary', 'iceland', 'finland', 'romania', 'slovakia', 'slovenia'],
  },
  { value: 'south-america', label: 'South America', countries: ['argentina', 'brazil', 'uruguay', 'colombia', 'chile', 'peru', 'ecuador', 'paraguay', 'venezuela', 'bolivia'] },
  { value: 'north-america', label: 'North & Central America', countries: ['usa', 'usmnt', 'united states', 'mexico', 'canada', 'costa rica', 'jamaica', 'panama', 'honduras', 'el salvador'] },
  {
    value: 'africa',
    label: 'Africa',
    countries: ['morocco', 'senegal', 'nigeria', 'ghana', 'cameroon', 'egypt', 'ivory coast', "côte d'ivoire", 'cote d.ivoire', 'algeria', 'tunisia', 'south africa', 'mali', 'burkina faso', 'dr congo'],
  },
  {
    value: 'asia',
    label: 'Asia',
    countries: ['cambodia', 'japan', 'korea', 'china', 'thailand', 'vietnam', 'viet nam', 'indonesia', 'malaysia', 'singapore', 'philippines', 'laos', 'myanmar', 'india', 'saudi arabia', 'iran', 'iraq', 'qatar', 'uae', 'united arab emirates', 'uzbekistan', 'jordan', 'oman', 'bahrain', 'kuwait'],
  },
  { value: 'oceania', label: 'Oceania', countries: ['australia', 'new zealand', 'fiji'] },
];

const productName = sql`lower(coalesce(p.name_i18n->>'en', ''))`;
/** A national team: the seeded league says so, or the name does ("… National Team …"). */
const isNationalTeam = sql`(p.attributes->>'league' = 'International' or ${productName} like '%national team%')`;
// "south africa" must win over nothing else, but "korea" etc. are whole words; match each name as whole words.
const wordPattern = (country: string) => `\\m${country.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '.' ? '.' : `\\${c}`))}\\M`;

/** The continent of a national-team product, or null (club kits and everything else). */
export const continentSql: SQL = sql`case when ${isNationalTeam} then case ${sql.join(
  CONTINENTS.flatMap((c) => c.countries.map((country) => sql`when ${productName} ~ ${wordPattern(country)} then ${c.value}`)),
  sql` `,
)} end end`;

/**
 * The season: the seeded value (e.g. "2026/27", "2002"), else read from the name ("2026/27", "2026-27").
 * Normalised to "YYYY/YY".
 */
export const seasonSql: SQL = sql`coalesce(
  nullif(p.attributes->>'season', ''),
  (select m[1] || '/' || m[2] from regexp_match(coalesce(p.name_i18n->>'en', ''), '((?:19|20)[0-9]{2})[/–-]([0-9]{2})(?![0-9])') as m)
)`;

/** "2026/27" → "2026–2027"; "1999/00" → "1999–2000"; a single year stays as it is. */
export function seasonLabel(season: string): string {
  const m = /^(\d{4})\/(\d{2})$/.exec(season);
  if (!m) return season;
  const start = Number(m[1]);
  const end = Math.floor(start / 100) * 100 + Number(m[2]);
  return `${start}–${end < start ? end + 100 : end}`;
}

/** Newest season first ("2026/27" before "2025/26" before "2002"). */
export const bySeasonDesc = (a: string, b: string) => Number(b.slice(0, 4)) - Number(a.slice(0, 4)) || b.localeCompare(a);
