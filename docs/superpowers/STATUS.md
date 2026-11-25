# Overnight run — status

Work order: `docs/superpowers/plans/2026-11-25-overnight-handoff.md`. Owner decisions: [OWNER-DECISIONS.md](OWNER-DECISIONS.md). Owner to-do: [OWNER-TODO.md](OWNER-TODO.md).

After a context reset, trust this file, the plan ledgers (`.superpowers/sdd/<plan>/progress.md`) and `git log` over memory.

| Stage | What | Plan file | Last commit | State |
|---|---|---|---|---|
| 0 | Bootstrap | (work order) | see git log | done |
| 1 | Backend phase 5: checkout, orders, payments | `plans/2026-11-25-phase-5-checkout-payments.md` | 92518d6 | tasks 1–9 done; final review running |
| 2 | Backend phase 6: post-purchase | `plans/2026-11-25-phase-6-post-purchase.md` | – | not started |
| 3 | Backend phase 7: hardening + deferred minors | `plans/2026-11-25-phase-7-hardening.md` | – | not started |
| 4 | Backend completeness audit | `BACKEND-AUDIT.md` | – | not started |
| 5 | Frontend design | `sport-heaven/docs/superpowers/specs/…` | – | not started |
| 6 | Frontend build | `sport-heaven/docs/superpowers/plans/…` | – | not started |
| 7 | Frontend audit | `sport-heaven/docs/superpowers/FRONTEND-AUDIT.md` | – | not started |
| 8 | Final report | `OVERNIGHT-REPORT.md` | – | not started |

## Test counts

| When | Backend | Frontend |
|---|---|---|
| Stage 0 (fresh DB, twice) | 281/281 | – |
| Stage 1 tasks done (twice) | 508/508 | frontend clean-up: 2/2 (typecheck, lint, build clean) |

## Rulings (cumulative)

- [Stage 0] Seed inserted shipping rates before the provinces they reference, so seeding a brand-new database failed (every integration test skipped). Geo is now seeded first in the same transaction.

## Frontend clean-up (done early, in parallel with Stage 1)

Commits `2c6a01a..4eb3e7a` in `sport-heaven`: the build/typecheck/lint/test now pass; backend-only code and deps removed (`server.ts`, `src/db`, `commerce.test.ts`, `@google/genai`, express, pg, drizzle, firebase-admin…); AI Studio leftovers removed (package name, `.gmp_cache`, `metadata.json`, the Maps quota banner, `DISABLE_HMR`); Firebase web config moved to `VITE_FIREBASE_*`; `/v1` dev proxy to the API; ESLint 9 + Vitest; `scripts/optimize-images.mjs` wrote WebP/AVIF/JPEG variants to `public/assets/catalog` (7.5 MB) and `public/assets/site` (1.2 MB). Open items for Stage 6: original images (≈56 MB) still in the repo and copied into `dist` by a Vite plugin; the system-health dashboard still points at old `/api/system-health*` URLs; 27 lint warnings in legacy screens; `npm audit` reports 4 high advisories; TypeScript pinned to 6.0 (typescript-eslint doesn't support 7 yet).

## Deferred minors (cumulative)

The phase 1–4 minors are listed in the work order §2; Stage 3 closes or rules out each one. New ones are added here as stages finish.
