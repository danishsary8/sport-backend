# Phase 2 — Auth & Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers sign in with Firebase (phone OTP or Google) and the API knows who they are. It stores them in Postgres with a role (customer / staff / admin, optional staff branch) and lets them manage their profile and Cambodian delivery addresses (Province → District → Commune). It also serves branches and the geo lists, lets admins assign roles, and lets customers delete their account.

**Architecture:** An `IdentityProvider` interface wraps `firebase-admin` (verify ID token, delete user). Tests inject a fake. Middleware: `requireAuth` → `req.auth` (verified claims), then `requireUser` → upserts or loads the `users` row into `req.user`, then `requireRole(...)`. Feature modules (`auth`, `account`, `geo`, `branches`, `admin/users`) each have a router + service + repo. Seed data (3 branches, 25 provinces / 210 districts / 1,652 communes) loads from committed JSON with an idempotent `seed(db)`.

**Tech Stack:** as phase 1, plus `libphonenumber-js` (phone normalisation for address recipients). Firebase Admin SDK v14.

**Spec:** `docs/superpowers/specs/2026-11-25-backend-production-design.md` (§2 decisions, §7 Authentication & identity, §8 Identity + Geo + `branches`, §13 account endpoints, §14 "users → set role", §16).

## Global Constraints

- Everything in the phase 1 plan's Global Constraints still applies (error shape, `.js` imports, request id, phone redaction in logs).
- Express 5 (upgraded in the phase 1 review): async handlers may throw; errors reach `errorHandler`.
- All new routes live under `/v1`. IDs are `uuid` (`gen_random_uuid()`); timestamps are `timestamptz`.
- Phone numbers are stored in E.164 (`+855…`). Firebase's `phone_number` claim is trusted as already E.164; address recipient phones are normalised with `libphonenumber-js`, default region `KH`.
- The identity key is `users.firebase_uid`. `phone_e164` is unique when not null.
- Roles: `customer` (default) | `staff` | `admin`. `staff_branch_id` null = all branches. Bootstrap admins (env `BOOTSTRAP_ADMIN_PHONES`, `BOOTSTRAP_ADMIN_EMAILS`, comma lists) are **promoted at login, never demoted**. An email only counts when the token's `email_verified` is true.
- A soft-deleted user (`deleted_at` set) gets `403 account_deleted` on every authenticated route.
- Auth failures: missing or malformed bearer → `401 unauthenticated`; an invalid, expired or revoked token → `401 invalid_token`; auth not configured (no Firebase project) → `503 auth_unavailable`; wrong role → `403 forbidden`.
- No customer phone, email or address appears in any public (unauthenticated) response.

## Review Focus

1. **A Google-only user later adds a phone** (the token now carries `phone_number`) → the next authenticated request saves the phone. If another *deleted* account still held that number, the deleted row was anonymised, so no unique-key 500. Pinned in Task 3.
2. **The same token hits two endpoints at once on first login** (the frontend fires `/auth/session` and `/me` together) → exactly one `users` row, no 500 from the unique constraint (upsert with `ON CONFLICT (firebase_uid)`). Pinned in Task 3.
3. **An address with a commune from a different district, or a district from a different province** → `400 validation_failed` naming the field, not a stored inconsistent address. Pinned in Task 5.
4. **A user edits, deletes or makes default an address id that belongs to someone else** → `404 not_found` (never 403, which would confirm it exists), and nothing changes. Pinned in Task 5.
5. **Deleting the last default address, or creating the first address** → the first address becomes the default automatically; deleting the default promotes the most recent remaining one. Pinned in Task 5.

---

## File structure (added in phase 2)

```
src/config/env.ts                       + firebase + bootstrap admin vars
src/lib/identity.ts                     IdentityProvider, AuthClaims, createFirebaseIdentity, createUnconfiguredIdentity
src/lib/phone.ts                        normalizePhone(input) → E.164 | null
src/middleware/auth.ts                  requireAuth, optionalAuth, requireUser, requireRole
src/db/schema/branches.ts  geo.ts  users.ts  addresses.ts   (+ index.ts exports)
src/db/seed/index.ts                    seed(db): branches + geo, idempotent
src/db/seed/run.ts                      CLI: npm run db:seed
src/db/seed/data/branches.json  provinces.json  districts.json  communes.json  GEO_LICENSE.md
src/modules/users/repo.ts  service.ts    upsertFromClaims, findById, anonymize, setRole, search
src/modules/auth/router.ts              POST /v1/auth/session
src/modules/account/router.ts  service.ts  repo.ts   /v1/me, /v1/me/addresses
src/modules/geo/router.ts  repo.ts      /v1/geo/*
src/modules/branches/router.ts          /v1/branches
src/modules/admin/usersRouter.ts        /v1/admin/users
drizzle/0001_identity_geo.sql           generated
test/helpers/db.ts                      testDb(), resetDb()
test/helpers/fakeIdentity.ts            fakeIdentity(): IdentityProvider + token builder
test/unit/phone.test.ts  identity.test.ts
test/integration/seed.test.ts  auth.test.ts  account.test.ts  addresses.test.ts  geo.test.ts  adminUsers.test.ts
```

`createApp` gains deps: `db: Database` (the full client, not only `ping`), `identity: IdentityProvider`, `bootstrapAdmins: { phones: string[]; emails: string[] }`.

---

### Task 1: Schema, seed data and seeding (branches + geo)

**Files:** schema files `branches.ts`, `geo.ts`; `src/db/seed/*`; `drizzle/0001_*.sql`; `test/helpers/db.ts`; `test/integration/seed.test.ts`

**Interfaces:**
- Produces tables:
  - `branches` (id text PK `sonthormuk|sensok|chomkadong`, name, short_name, address, district, phone_e164, telegram, hours, landmarks, lat double null, lng double null, pickup_enabled bool default true, sort int)
  - `geo_provinces` (code text PK `'01'..'25'`, name_km, name_en)
  - `geo_districts` (code text PK e.g. `'102'`, province_code FK, name_km, name_en)
  - `geo_communes` (code text PK e.g. `'10201'`, district_code FK, name_km, name_en)
  - Indexes on `geo_districts(province_code)` and `geo_communes(district_code)`.
- Produces `seed(db: Db): Promise<{ branches: number; provinces: number; districts: number; communes: number }>`, which upserts (`ON CONFLICT DO UPDATE` names) so re-running is safe.
- Produces `testDb(): Database` (a shared instance for `TEST_DATABASE_URL`, migrations applied once) and `resetDb(db)`, which truncates every non-reference table (`users`, `addresses`, and later tables) `RESTART IDENTITY CASCADE` and leaves `branches` + geo seeded.
- Parent codes: district → province = `code.slice(0, -2).padStart(2, '0')`; commune → district = `code.slice(0, -2)`. Verify during seeding: a missing parent throws.

- [ ] **Step 1:** Copy `provinces.json`, `districts.json`, `communes.json` from `@sothikhorn/cambodia-gazetteer@2.2.0` `data/` into `src/db/seed/data/`, keeping `{code, name, en_name}`. Add `GEO_LICENSE.md` with the MIT notice and source (Open Development Mekong, NCDD codes). `branches.json` holds the 3 branches from `sport-heaven/src/data/catalog.ts` `BRANCHES` (phones converted to E.164, lat/lng null).
- [ ] **Step 2: Failing test** `seed.test.ts`:
  - After `seed(db)`: counts are 3 / 25 / 210 / 1652.
  - Running `seed` twice keeps the same counts.
  - Province `'12'` has `name_en 'Phnom Penh'` and `name_km 'ភ្នំពេញ'`.
  - Every district's `province_code` and every commune's `district_code` exists (a left-join count of orphans = 0).
  - Branch `sonthormuk` has `phone_e164 '+85512889261'`.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement the schema, `db:generate` (rename to `0001_identity_geo.sql` after Task 2's tables are added; generate once, at the end of Task 2) and `seed` (batched inserts of 500 rows). Add the script `db:seed`: `node dist/db/seed/run.js`. JSON is imported with `with { type: 'json' }` so `tsc` copies it to `dist`.
- [ ] **Step 5:** Run → PASS. Commit `feat: branches and Cambodian geo reference data with idempotent seed`.

### Task 2: Users and addresses tables, config, identity provider

**Files:** `users.ts`, `addresses.ts` schema; `src/config/env.ts`; `src/lib/identity.ts`; `src/lib/phone.ts`; `test/helpers/fakeIdentity.ts`; `test/unit/identity.test.ts`, `test/unit/phone.test.ts`, `test/unit/config.test.ts` (extend)

**Interfaces:**
- `users`: id uuid PK, firebase_uid text unique not null, phone_e164 text unique null, email text null, full_name text null, photo_url text null, role text not null default `'customer'` with check in (`customer`,`staff`,`admin`), staff_branch_id FK branches null, home_branch_id FK branches null, preferred_boot_size text null, preferred_jersey_size text null, created_at, updated_at, deleted_at null.
- `addresses`: id uuid PK, user_id FK users ON DELETE CASCADE, label text not null (≤40), recipient_name (≤120), phone_e164, province_code FK, district_code FK, commune_code FK, street (≤240), landmark (≤240) null, lat/lng double null, is_default bool, created_at, updated_at. Index `(user_id)`; partial unique index `(user_id) WHERE is_default`.
- Config adds:
  - `firebaseServiceAccount: object | undefined` from `FIREBASE_SERVICE_ACCOUNT_JSON` (must parse as JSON with `project_id`, `client_email`, `private_key`);
  - `bootstrapAdminPhones: string[]` (normalised E.164) and `bootstrapAdminEmails: string[]` (lowercased).
  - In production, `FIREBASE_PROJECT_ID` **and** `FIREBASE_SERVICE_ACCOUNT_JSON` are required.
- `identity.ts`:
  ```ts
  export interface AuthClaims { uid: string; phone: string | null; email: string | null; emailVerified: boolean; name: string | null; picture: string | null; signInProvider: string | null; }
  export interface IdentityProvider { verifyIdToken(token: string): Promise<AuthClaims>; deleteUser(uid: string): Promise<void>; }
  export class InvalidTokenError extends Error {}
  export class IdentityUnavailableError extends Error {}
  export function createFirebaseIdentity(cfg: { projectId: string; serviceAccount?: object }): IdentityProvider;
  export function createUnconfiguredIdentity(): IdentityProvider;   // every call throws IdentityUnavailableError
  ```
  `createFirebaseIdentity` calls `verifyIdToken(token, checkRevoked = !!serviceAccount)`. It caches decoded claims per SHA-256 of the token until `min(exp, now + 5 min)`, with at most 5,000 entries (LRU-by-insertion eviction). Firebase `auth/*` errors become `InvalidTokenError`; network or other errors become `IdentityUnavailableError`. Each app gets a unique `initializeApp(…, 'sport-backend')` name.
- `fakeIdentity()` returns `{ provider, token(claims: Partial<AuthClaims> & {uid: string}): string, deleted: string[] }`. Tokens are opaque strings that map to claims; unknown tokens throw `InvalidTokenError`; `deleteUser` pushes to `deleted`.
- `normalizePhone(input: string, region = 'KH'): string | null`: `'012 345 678'` → `'+85512345678'`, `'+855 96 889 217'` → `'+85596889217'`; `'123'` and `'abc'` → null.

- [ ] **Step 1: Failing tests.**
  - `phone.test.ts`: the cases above.
  - `identity.test.ts` (with a stubbed `firebase-admin` `Auth` passed via an internal factory parameter `createFirebaseIdentity(cfg, authOverride?)`):
    - The second verify of the same token doesn't call the stub again.
    - An expired cache entry calls it again.
    - Error code `auth/id-token-revoked` → `InvalidTokenError`.
    - A generic `Error('ECONNRESET')` → `IdentityUnavailableError`.
    - Claims map `phone_number` → `phone`, `firebase.sign_in_provider` → `signInProvider`.
  - `config.test.ts`:
    - Production without `FIREBASE_SERVICE_ACCOUNT_JSON` → issue names it.
    - Invalid JSON → issue names it.
    - `BOOTSTRAP_ADMIN_PHONES: '012 345 678, +85596889217'` → `['+85512345678','+85596889217']`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Generate migration `0001_identity_geo.sql` (Task 1 + 2 tables). **Step 4:** Run → PASS. Commit `feat: users and addresses schema, firebase identity provider, phone normalisation`.

### Task 3: Auth middleware, user upsert, `POST /v1/auth/session`, `GET /v1/me`

**Files:** `src/modules/users/repo.ts`, `service.ts`; `src/middleware/auth.ts`; `src/modules/auth/router.ts`; `src/modules/account/router.ts` (GET only); `src/app.ts`, `src/server.ts` wiring; `test/integration/auth.test.ts`

**Interfaces:**
- `usersRepo.upsertFromClaims(db, claims, bootstrap): Promise<{ user: UserRow; created: boolean }>`, implemented as a single `INSERT … ON CONFLICT (firebase_uid) DO UPDATE` that:
  - refreshes `phone_e164` (only when the claim has one), `email` (only when verified), `photo_url`, and `full_name` only if it is currently null;
  - sets `role = 'admin'` when bootstrap matches, otherwise keeps the role;
  - bumps `updated_at`.
  - `created` comes from `xmax = 0`.
  - Before the upsert, if `claims.phone` is held by a **different** row with `deleted_at` not null, that row's phone is set to null in the same transaction.
- `UserView` (public shape): `{ id, phone, email, fullName, photoUrl, role, staffBranchId, homeBranchId, preferredBootSize, preferredJerseySize, phoneVerified: boolean, createdAt }`.
- Middleware:
  - `requireAuth(identity)` → `req.auth: AuthClaims`.
  - `optionalAuth(identity)` → `req.auth` or undefined; an invalid token is ignored.
  - `requireUser(db, bootstrap)` → `req.user: UserRow` (upserts, rejects deleted).
  - `requireRole(...roles)`.
  - Express `Request` augmented with `auth?` and `user?`.
- Routes:
  - `POST /v1/auth/session` → `200 { user: UserView, created }` (the guest-cart merge is added in phase 4; leave a `// phase 4: merge guest cart` hook in the service).
  - `GET /v1/me` → `{ user: UserView }`.

- [ ] **Step 1: Failing tests** `auth.test.ts` (real DB + `fakeIdentity`):
  - No `Authorization` → 401 `unauthenticated`; `Bearer junk` → 401 `invalid_token`.
  - With `createUnconfiguredIdentity()` → 503 `auth_unavailable`.
  - A phone sign-in token → `/auth/session` 200, `created: true`, `user.phone === '+85512345678'`, `role === 'customer'`; the second call → `created: false`, same id.
  - Google token (email, no phone) → `phone: null`, `phoneVerified: false`. Then the same uid with `phone` → `/me` shows the phone (Review Focus 1).
  - A deleted user (`deleted_at` set) holding `+85599999999`, and a new uid signing in with that phone → 200, the new row gets the phone, and the old row's phone is null.
  - Bootstrap: phone in `bootstrapAdmins.phones` → `role: 'admin'`. After a manual demotion to `staff`, the next login → `admin` again (bootstrap always promotes). An unverified email in the bootstrap list → `customer`.
  - Concurrency (Review Focus 2): `Promise.all` of `/auth/session` and `/me` with a fresh token → both 200, `select count(*) from users` = 1.
  - Deleted user → `/me` 403 `account_deleted`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement and wire: `createApp` takes `db` (`Database`), `identity`, `bootstrapAdmins`. `server.ts` builds the identity from config (`createFirebaseIdentity` when `firebaseProjectId` is set, else `createUnconfiguredIdentity` and a startup warning). Update phase 1 tests' `buildApp` helpers to pass the new deps (a fake identity; `db` from `testDb()` or a stub exposing `ping`). **Step 4:** Run the whole suite → PASS. Commit `feat: firebase auth middleware, user upsert, auth session and me endpoints`.

### Task 4: Profile update, account deletion, branches and geo endpoints

**Files:** `src/modules/account/service.ts`, `router.ts` (extend); `src/modules/geo/*`; `src/modules/branches/router.ts`; `test/integration/account.test.ts`, `geo.test.ts`

**Interfaces:**
- `PATCH /v1/me` body (all optional, ≥1 key): `fullName` (1–120), `preferredBootSize` (≤10, e.g. `'EU 42'`), `preferredJerseySize` (enum `XS S M L XL XXL 3XL`), `homeBranchId` (an existing branch id; unknown → 400 `validation_failed` path `homeBranchId`). Phone, email and role are **not** accepted (stripped). Returns `{ user }`.
- `DELETE /v1/me` → 204. In one transaction:
  - delete addresses;
  - set `phone_e164 = null, email = null, full_name = null, photo_url = null, deleted_at = now()`.
  
  Then `identity.deleteUser(uid)`. If that throws, log a warning and still return 204 (the row is already locked out).
- `GET /v1/branches` → `{ branches: [{ id, name, shortName, address, district, phone, telegram, hours, landmarks, lat, lng, pickupEnabled }] }` sorted by `sort`, `Cache-Control: public, max-age=300`.
- `GET /v1/geo/provinces` → `{ provinces: [{ code, nameEn, nameKm }] }` sorted by `name_en`.
- `GET /v1/geo/districts?provinceCode=12` → `{ districts: [...] }`. A missing or unknown province code → 400 / empty list respectively.
- `GET /v1/geo/communes?districtCode=1201` → `{ communes: [...] }`.
- All geo responses: `Cache-Control: public, max-age=86400`.

- [ ] **Step 1: Failing tests.**
  - `account.test.ts`:
    - Patch fullName + jersey size → reflected in `/me`.
    - `{ role: 'admin' }` alone → 400 (no allowed keys); with `fullName` too → role unchanged.
    - Unknown `homeBranchId` → 400 path `homeBranchId`.
    - DELETE → 204, `fake.deleted` contains the uid, and the next `/me` with the same token → 403 `account_deleted`.
    - DELETE when `deleteUser` throws → still 204.
  - `geo.test.ts`:
    - 25 provinces; Phnom Penh districts (`provinceCode=12`) include `Chamkar Mon` (by `nameEn`).
    - Communes for a district all share its prefix.
    - Missing `provinceCode` → 400.
    - The branches list has 3, first `sonthormuk`, with a cache header.
    - The responses contain no `users` data (sanity: no `phone` key at top level).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (whole suite). Commit `feat: profile update, account deletion, branches and geo endpoints`.

### Task 5: Addresses

**Files:** `src/modules/account/addressRepo.ts`, `addressService.ts`, router additions; `test/integration/addresses.test.ts`

**Interfaces:**
- `GET /v1/me/addresses` → `{ addresses: AddressView[] }`, default first, then newest.
- `POST /v1/me/addresses` body:
  - `label` (1–40)
  - `recipientName` (1–120)
  - `phone` (any format; normalised; invalid → 400 path `phone`)
  - `provinceCode`, `districtCode`, `communeCode`
  - `street` (1–240), `landmark?` (≤240)
  - `lat?`/`lng?` (both or neither, in Cambodia's bounding box lat 9.5–15, lng 102–108)
  - `isDefault?`
  
  → 201 `{ address }`. At most 20 addresses per user (`409 address_limit`).
- `PATCH /v1/me/addresses/:id` (any subset; hierarchy re-validated against the resulting codes) → `{ address }`. `DELETE /v1/me/addresses/:id` → 204. `POST /v1/me/addresses/:id/default` → `{ address }`.
- `AddressView`: `{ id, label, recipientName, phone, province: {code, nameEn, nameKm}, district: {...}, commune: {...}, street, landmark, lat, lng, isDefault, createdAt }`.
- Rules:
  - hierarchy check (the commune's district = `districtCode`, the district's province = `provinceCode`), otherwise 400 with the offending path (Review Focus 3);
  - another user's id → 404 (Review Focus 4);
  - first address → default; setting a default clears the other in the same transaction; deleting the default → the newest remaining becomes default (Review Focus 5);
  - `:id` not a uuid → 404, not 500.

- [ ] **Step 1: Failing tests** `addresses.test.ts` covering each rule above. Use real codes: Phnom Penh `12`, Chamkar Mon district and one of its communes (looked up from the seeded tables in `beforeAll`), plus a commune from a different district for the mismatch.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (whole suite). Commit `feat: member addresses with Cambodian geo validation`.

### Task 6: Admin user management

**Files:** `src/modules/admin/usersRouter.ts`, `src/modules/users/service.ts` (extend); `test/integration/adminUsers.test.ts`

**Interfaces:**
- Mounted at `/v1/admin/users`, behind `requireAuth → requireUser → requireRole('admin')`.
- `GET /v1/admin/users?q=&role=&page=1&pageSize=20` (max 100): `q` matches phone digits, email or name, case-insensitive. Returns `{ users: UserView[], total, page, pageSize }` and excludes deleted users.
- `PATCH /v1/admin/users/:id/role { role, staffBranchId? }`:
  - `staffBranchId` is only allowed when `role === 'staff'` (otherwise 400); setting a role other than `staff` clears it.
  - An admin cannot change **their own** role (`409 cannot_change_own_role`), so the last admin can't lock everyone out.
  - Writes `updated_at`. Returns `{ user }`.

- [ ] **Step 1: Failing tests:**
  - A customer → 403 `forbidden`; staff → 403.
  - Admin lists and searches by `'345678'`, finding the user with `+85512345678`.
  - Promote to staff with `sensok` → `staffBranchId: 'sensok'`. Then to customer → `staffBranchId` null.
  - `staffBranchId` with role admin → 400. Own role → 409. Unknown id → 404.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (whole suite + typecheck + build). Update `README.md` (new env vars, `db:seed`, endpoints list) and `.env.example`; port nothing else from `legacy/` and delete `legacy/middleware/auth.ts` and `legacy/lib/firebaseAdmin.ts` (now superseded). Commit `feat: admin user role management`.

---

## Deferred to later phases (explicitly not in phase 2)

- Wishlist, which needs `products` (phase 3), so it moves to phase 3. *(Deviation from spec §19 item 2, ruled: a wishlist without a products FK would need rework.)*
- Guest-cart merge in `/auth/session` (phase 4; the hook is left in the service).
- Loyalty `phoneVerified` gating is consumed in phase 6; phase 2 only exposes `phoneVerified`.
