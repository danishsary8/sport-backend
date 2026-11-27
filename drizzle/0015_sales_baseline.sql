CREATE TABLE "sales_baseline" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"units" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_baseline_units_check" CHECK ("units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sales_baseline" ADD CONSTRAINT "sales_baseline_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
