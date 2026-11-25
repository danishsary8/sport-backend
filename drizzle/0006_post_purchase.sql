CREATE TABLE "product_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"user_id" uuid,
	"author_name" text NOT NULL,
	"question" text NOT NULL,
	"answer" text,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_questions_status_check" CHECK ("product_questions"."status" in ('pending', 'published', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "rma_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rma_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"qty" integer NOT NULL,
	"reason" text NOT NULL,
	"exchange_variant_id" uuid,
	"exchange_branch_id" text,
	"refund_cents" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rma_items_qty_check" CHECK ("rma_items"."qty" > 0),
	CONSTRAINT "rma_items_refund_check" CHECK ("rma_items"."refund_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rma_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"resolution" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"refund_cents" integer DEFAULT 0 NOT NULL,
	"note" text,
	"decision_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rma_requests_number_unique" UNIQUE("number"),
	CONSTRAINT "rma_requests_resolution_check" CHECK ("rma_requests"."resolution" in ('refund', 'size_exchange', 'store_credit')),
	CONSTRAINT "rma_requests_status_check" CHECK ("rma_requests"."status" in ('requested', 'approved', 'rejected')),
	CONSTRAINT "rma_requests_refund_check" CHECK ("rma_requests"."refund_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "loyalty_ledger" DROP CONSTRAINT "loyalty_ledger_reason_check";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_questions" ADD CONSTRAINT "product_questions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_questions" ADD CONSTRAINT "product_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_questions" ADD CONSTRAINT "product_questions_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_items" ADD CONSTRAINT "rma_items_rma_id_rma_requests_id_fk" FOREIGN KEY ("rma_id") REFERENCES "public"."rma_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_items" ADD CONSTRAINT "rma_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_items" ADD CONSTRAINT "rma_items_exchange_variant_id_variants_id_fk" FOREIGN KEY ("exchange_variant_id") REFERENCES "public"."variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_items" ADD CONSTRAINT "rma_items_exchange_branch_id_branches_id_fk" FOREIGN KEY ("exchange_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_requests" ADD CONSTRAINT "rma_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_requests" ADD CONSTRAINT "rma_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rma_requests" ADD CONSTRAINT "rma_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_questions_product_idx" ON "product_questions" USING btree ("product_id","status","created_at");--> statement-breakpoint
CREATE INDEX "rma_items_rma_idx" ON "rma_items" USING btree ("rma_id");--> statement-breakpoint
CREATE INDEX "rma_items_order_item_idx" ON "rma_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "rma_requests_user_idx" ON "rma_requests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "rma_requests_status_idx" ON "rma_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rma_requests_order_idx" ON "rma_requests" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_reason_check" CHECK ("loyalty_ledger"."reason" in ('order_paid', 'rma_reversal', 'order_cancelled', 'admin'));