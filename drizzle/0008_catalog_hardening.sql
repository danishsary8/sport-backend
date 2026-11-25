-- Colour names are unique per product regardless of case. Rename any existing duplicates first.
UPDATE "product_colors" pc SET "name" = pc."name" || ' (' || left(pc."id"::text, 4) || ')'
WHERE EXISTS (
  SELECT 1 FROM "product_colors" other
  WHERE other."product_id" = pc."product_id" AND lower(other."name") = lower(pc."name") AND other."id" < pc."id"
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_colors_product_lower_name_idx" ON "product_colors" ("product_id", lower("name"));--> statement-breakpoint
-- Accent-free search text (the app folds accents the same way when searching).
UPDATE "products" SET "search_text" = unaccent("search_text") WHERE "search_text" IS NOT NULL;
