-- Shop prices always end in .90: each price that doesn't moves down to the .90 just below it ($95.00 -> $94.90).
-- "Was" prices are unchanged (lowering a price keeps them above it). Placed orders keep the prices they were sold at.
UPDATE "variants"
SET "price_cents" = CASE WHEN "price_cents" <= 90 THEN 90 ELSE (("price_cents" - 90) / 100) * 100 + 90 END
WHERE "price_cents" % 100 <> 90;
