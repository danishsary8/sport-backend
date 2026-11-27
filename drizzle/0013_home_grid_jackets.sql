-- The home page "Shop by category" grid shows Jackets where it showed GK & Essentials, matching the top menu.
-- Only a grid that still lists essentials (and not jackets) changes, so later admin edits are kept.
UPDATE "home_sections"
SET "payload" = jsonb_set(
  "payload",
  '{categories}',
  (
    SELECT jsonb_agg(CASE WHEN e.v = '"essentials"'::jsonb THEN '"jackets"'::jsonb ELSE e.v END ORDER BY e.o)
    FROM jsonb_array_elements("payload"->'categories') WITH ORDINALITY AS e(v, o)
  )
)
WHERE "type" = 'category_grid'
  AND "payload"->'categories' ? 'essentials'
  AND NOT ("payload"->'categories' ? 'jackets');
