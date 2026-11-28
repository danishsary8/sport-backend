-- Delivery is a flat $2.00 (Phnom Penh rider and province courier); pick up in store stays free.
UPDATE "shipping_rates" SET "fee_cents" = 200, "needs_review" = false WHERE "method_id" IN ('pp_rider', 'province_courier');
--> statement-breakpoint
-- Printing a name and number costs $4.00 (patch prices unchanged).
UPDATE "settings" SET "value" = jsonb_set("value", '{baseCents}', '400'), "updated_at" = now() WHERE "key" = 'custom_print_fees';
