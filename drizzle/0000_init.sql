CREATE TYPE "public"."branch" AS ENUM('sonthormuk', 'sensok', 'chomkadong');--> statement-breakpoint
CREATE TYPE "public"."product_category" AS ENUM('jerseys', 'boots', 'f1', 'balls', 'essentials');--> statement-breakpoint
CREATE TYPE "public"."kit_type" AS ENUM('home', 'away', 'third', 'goalkeeper', 'special');--> statement-breakpoint
CREATE TYPE "public"."team_type" AS ENUM('club', 'national');--> statement-breakpoint
CREATE TABLE "product_stock" (
	"product_id" uuid NOT NULL,
	"branch" "branch" NOT NULL,
	"size" text NOT NULL,
	"quantity" integer NOT NULL,
	CONSTRAINT "product_stock_product_id_branch_size_pk" PRIMARY KEY("product_id","branch","size"),
	CONSTRAINT "product_stock_quantity_non_negative" CHECK ("product_stock"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"brand" text NOT NULL,
	"brand_slug" text NOT NULL,
	"category" "product_category" NOT NULL,
	"league" text,
	"league_slug" text,
	"team" text,
	"team_slug" text,
	"team_type" "team_type",
	"season" text,
	"season_slug" text,
	"kit_type" "kit_type",
	"versions" text[] DEFAULT '{}'::text[] NOT NULL,
	"fits" text[] DEFAULT '{}'::text[] NOT NULL,
	"sleeves" text[] DEFAULT '{}'::text[] NOT NULL,
	"price_cents" integer NOT NULL,
	"original_price_cents" integer,
	"customizable" boolean DEFAULT false NOT NULL,
	"rating" numeric(2, 1) DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"featured_rank" integer DEFAULT 0 NOT NULL,
	"released_at" date DEFAULT current_date NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"highlights" text[] DEFAULT '{}'::text[] NOT NULL,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"media" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_slug_unique" UNIQUE("slug"),
	CONSTRAINT "products_price_positive" CHECK ("products"."price_cents" > 0),
	CONSTRAINT "products_original_above_price" CHECK ("products"."original_price_cents" is null or "products"."original_price_cents" > "products"."price_cents"),
	CONSTRAINT "products_rating_range" CHECK ("products"."rating" between 0 and 5)
);
--> statement-breakpoint
ALTER TABLE "product_stock" ADD CONSTRAINT "product_stock_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_category_rank_idx" ON "products" USING btree ("category","featured_rank");--> statement-breakpoint
CREATE INDEX "products_league_idx" ON "products" USING btree ("league_slug");--> statement-breakpoint
CREATE INDEX "products_team_idx" ON "products" USING btree ("team_slug");--> statement-breakpoint
CREATE INDEX "products_brand_idx" ON "products" USING btree ("brand_slug");--> statement-breakpoint
CREATE INDEX "products_price_idx" ON "products" USING btree ("price_cents");