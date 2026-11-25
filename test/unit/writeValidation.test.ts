import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Write routes that take no body (or verify their own, like the payment webhook). */
const BODYLESS = new Set([
  "delete '/me'",
  "delete '/me/addresses/:id'",
  "post '/me/addresses/:id/default'",
  "put '/me/wishlist/:product'",
  "delete '/me/wishlist/:product'",
  "delete '/cart/items/:id'",
  "delete '/cart/promo'",
  "post '/auth/session'",
  "post '/admin/orders/:number/collect-cash'",
  "post '/dev/payments/:tranId/approve'",
  "post '/webhooks/payway'",
  // Validated in the handler with the schema of the setting being changed.
  "put '/admin/settings/pricing/:key'",
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('every write endpoint validates its input', () => {
  it('has validate({ body }) or is a known bodyless route', () => {
    const missing: string[] = [];
    for (const file of files(path.resolve('src/modules'))) {
      const src = readFileSync(file, 'utf8');
      const re = /router\.(post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)async \(/g;
      for (const m of src.matchAll(re)) {
        const id = `${m[1]} '${m[2]}'`;
        if (/validate\(\{[\s\S]*?body\s*:/.test(m[3]!) || BODYLESS.has(id)) continue;
        missing.push(`${path.relative(process.cwd(), file)}: ${id}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
