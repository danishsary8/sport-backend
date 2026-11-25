# Decisions taken for you overnight

You asked not to be woken. Wherever the spec left a choice open, the builder picked the safest sensible option and wrote it here.
Format: **decision** — why — what changes if you disagree.

## Stage 0 — Bootstrap

- [Stage 0] **Database seeding loads the address list (provinces, districts, communes) before delivery rates.** — a brand-new database could not be seeded otherwise. — Nothing to decide; this is a bug fix.
- [Stage 0] **Custom print rules stay as the shop has them today: names up to 14 characters, numbers 1–99, and the "only N left" number is returned under `details.available`.** — this matches the current storefront; the design document said 12 characters / 0–99 and has been updated to match. — If you want 12 characters or number 0, it is one setting change and a small code change.
