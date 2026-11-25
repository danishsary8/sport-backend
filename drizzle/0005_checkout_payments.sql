CREATE TABLE "idempotency_keys" (
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "loyalty_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"order_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_ledger_reason_check" CHECK ("loyalty_ledger"."reason" in ('order_paid', 'rma_reversal', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_item_allocations" (
	"order_item_id" uuid NOT NULL,
	"branch_id" text NOT NULL,
	"qty" integer NOT NULL,
	CONSTRAINT "order_item_allocations_order_item_id_branch_id_pk" PRIMARY KEY("order_item_id","branch_id"),
	CONSTRAINT "order_item_allocations_qty_check" CHECK ("order_item_allocations"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"product_snapshot" jsonb NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"compare_at_cents" integer,
	"print_fee_cents" integer DEFAULT 0 NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"line_total_cents" integer NOT NULL,
	"qty" integer NOT NULL,
	"custom_print" jsonb,
	CONSTRAINT "order_items_qty_check" CHECK ("order_items"."qty" between 1 and 20),
	CONSTRAINT "order_items_total_check" CHECK ("order_items"."discount_cents" >= 0 and "order_items"."line_total_cents" = ("order_items"."unit_price_cents" + "order_items"."print_fee_cents") * "order_items"."qty" - "order_items"."discount_cents")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"user_id" uuid,
	"contact_name" text NOT NULL,
	"contact_phone_e164" text NOT NULL,
	"contact_email" text,
	"contact_channel" text NOT NULL,
	"fulfillment" text NOT NULL,
	"pickup_branch_id" text,
	"ship_address" jsonb,
	"shipping_method_id" text,
	"status" text NOT NULL,
	"payment_status" text DEFAULT 'unpaid' NOT NULL,
	"payment_method" text NOT NULL,
	"needs_refund" boolean DEFAULT false NOT NULL,
	"merchandise_cents" integer NOT NULL,
	"discount_cents" integer NOT NULL,
	"shipping_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"khr_rate" integer NOT NULL,
	"total_khr" integer NOT NULL,
	"promo_code" text,
	"promotion_id" uuid,
	"pricing" jsonb NOT NULL,
	"note" text,
	"reserved_until" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_number_unique" UNIQUE("number"),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('pending_payment', 'awaiting_pickup_payment', 'confirmed', 'printing', 'ready_for_pickup', 'out_for_delivery', 'delivered', 'completed', 'cancelled', 'expired')),
	CONSTRAINT "orders_payment_status_check" CHECK ("orders"."payment_status" in ('unpaid', 'paid', 'refunded')),
	CONSTRAINT "orders_payment_method_check" CHECK ("orders"."payment_method" in ('aba_khqr', 'card', 'acleda', 'wing', 'cash_on_pickup')),
	CONSTRAINT "orders_channel_check" CHECK ("orders"."contact_channel" in ('phone', 'telegram', 'whatsapp')),
	CONSTRAINT "orders_fulfillment_check" CHECK ("orders"."fulfillment" in ('delivery', 'pickup')),
	CONSTRAINT "orders_pickup_branch_check" CHECK (("orders"."fulfillment" = 'pickup') = ("orders"."pickup_branch_id" is not null)),
	CONSTRAINT "orders_money_check" CHECK ("orders"."merchandise_cents" >= 0 and "orders"."discount_cents" >= 0 and "orders"."shipping_cents" >= 0 and "orders"."total_cents" >= 0
        and "orders"."total_cents" = "orders"."merchandise_cents" - "orders"."discount_cents" + "orders"."shipping_cents")
);
--> statement-breakpoint
CREATE TABLE "payment_webhook_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"signature_valid" boolean NOT NULL,
	"processing_status" text NOT NULL,
	"tran_id" text,
	"payload" jsonb NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_tran_id" text NOT NULL,
	"method" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text NOT NULL,
	"instructions" jsonb,
	"raw" jsonb,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_tran_id_unique" UNIQUE("provider_tran_id"),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('pending', 'approved', 'declined', 'refunded', 'expired', 'cancelled')),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promotion_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"promotion_id" uuid NOT NULL,
	"user_id" uuid,
	"order_id" uuid NOT NULL,
	"contact_phone_e164" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_redemptions_order_id_unique" UNIQUE("order_id")
);
--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_allocations" ADD CONSTRAINT "order_item_allocations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_allocations" ADD CONSTRAINT "order_item_allocations_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pickup_branch_id_branches_id_fk" FOREIGN KEY ("pickup_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shipping_method_id_shipping_methods_id_fk" FOREIGN KEY ("shipping_method_id") REFERENCES "public"."shipping_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "loyalty_ledger_user_idx" ON "loyalty_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_ledger_order_paid_idx" ON "loyalty_ledger" USING btree ("order_id","reason") WHERE "loyalty_ledger"."order_id" is not null and "loyalty_ledger"."reason" = 'order_paid';--> statement-breakpoint
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_phone_idx" ON "orders" USING btree ("contact_phone_e164");--> statement-breakpoint
CREATE INDEX "orders_status_reserved_idx" ON "orders" USING btree ("status","reserved_until");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_event_idx" ON "payment_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_order_attempt_idx" ON "payments" USING btree ("order_id","attempt");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_promo_idx" ON "promotion_redemptions" USING btree ("promotion_id","user_id");--> statement-breakpoint
CREATE INDEX "promotion_redemptions_phone_idx" ON "promotion_redemptions" USING btree ("promotion_id","contact_phone_e164");