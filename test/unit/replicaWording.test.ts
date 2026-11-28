import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rewordReplica } from '../../src/db/fixes/replicaWording.js';

describe('rewordReplica', () => {
  it('drops authenticity claims and states the replica honestly', () => {
    expect(rewordReplica('Real Madrid 2026/27 Home Authentic Jersey')).toBe('Real Madrid 2026/27 Home Jersey');
    expect(rewordReplica('2026/27 Authentic Adidas Import')).toBe('2026/27 Grade A Replica');
    expect(rewordReplica('Authentic Retail Import')).toBe('Grade A Replica');
    expect(rewordReplica('Official low-bounce Size 4 futsal ball')).toBe('Low-bounce Size 4 futsal ball');
    expect(rewordReplica('Cambodia National Team Home Jersey (Varaman Official)')).toBe('Cambodia National Team Home Jersey (Varaman)');
    expect(rewordReplica('Slim Authentic Player Fit')).toBe('Slim Player Fit');
  });
  it('keeps the ball size standard and leaves other text alone', () => {
    expect(rewordReplica('430g (Official Size 5)')).toBe('430g (Official Size 5)');
    expect(rewordReplica('boots')).toBe('boots');
    expect(rewordReplica('Breathable mesh. Slim cut.')).toBe('Breathable mesh. Slim cut.');
  });
  it('leaves no authenticity claim in the starter catalogue', () => {
    const text = readFileSync(new URL('../../src/db/seed/data/catalog.json', import.meta.url), 'utf8');
    const claims = (JSON.parse(text) as Record<string, unknown>[])
      .flatMap((p) => Object.entries(p).filter(([k]) => k !== 'slug' && k !== 'id').map(([, v]) => JSON.stringify(v)))
      .flatMap((s) => s.match(/\b(?:[Aa]uthentic|[Oo]fficial(?:ly)?|[Ll]icensed)\b(?! Size)/g) ?? []);
    expect(claims).toEqual([]);
  });
});
