-- Home page rails follow real data: "New arrivals" lists the newest products added, "Best sellers" the products
-- that sold the most units (sort best_selling). Best sellers moves above the category grid, New arrivals below it.
-- Only rails still holding the original hand-picked queries change, so later admin edits are kept.
UPDATE "home_sections" SET "payload" = jsonb_set("payload", '{query}', '{"sort": "new"}'::jsonb)
WHERE "type" = 'product_rail' AND "payload"->'query' = '{"tag": ["new"], "sort": "new"}'::jsonb;
--> statement-breakpoint
UPDATE "home_sections" SET "payload" = jsonb_set("payload", '{query}', '{"sort": "best_selling"}'::jsonb)
WHERE "type" = 'product_rail' AND "payload"->'query' = '{"tag": ["best_seller"]}'::jsonb;
--> statement-breakpoint
-- Swap places only while both rails sit where the starting home page put them (New arrivals 2, Best sellers 4).
UPDATE "home_sections" SET "sort" = CASE "sort" WHEN 2 THEN 4 ELSE 2 END
WHERE "type" = 'product_rail' AND (
  ("sort" = 2 AND "payload"->'query' = '{"sort": "new"}'::jsonb) OR ("sort" = 4 AND "payload"->'query' = '{"sort": "best_selling"}'::jsonb)
) AND (
  SELECT count(*) FROM "home_sections" h WHERE h."type" = 'product_rail' AND (
    (h."sort" = 2 AND h."payload"->'query' = '{"sort": "new"}'::jsonb) OR (h."sort" = 4 AND h."payload"->'query' = '{"sort": "best_selling"}'::jsonb))
) = 2;
