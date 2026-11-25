CREATE TABLE "branches" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL,
	"address" text NOT NULL,
	"district" text NOT NULL,
	"phone_e164" text NOT NULL,
	"telegram" text,
	"hours" text NOT NULL,
	"landmarks" text,
	"lat" double precision,
	"lng" double precision,
	"pickup_enabled" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_communes" (
	"code" text PRIMARY KEY NOT NULL,
	"district_code" text NOT NULL,
	"name_km" text NOT NULL,
	"name_en" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_districts" (
	"code" text PRIMARY KEY NOT NULL,
	"province_code" text NOT NULL,
	"name_km" text NOT NULL,
	"name_en" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geo_provinces" (
	"code" text PRIMARY KEY NOT NULL,
	"name_km" text NOT NULL,
	"name_en" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "geo_communes" ADD CONSTRAINT "geo_communes_district_code_geo_districts_code_fk" FOREIGN KEY ("district_code") REFERENCES "public"."geo_districts"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geo_districts" ADD CONSTRAINT "geo_districts_province_code_geo_provinces_code_fk" FOREIGN KEY ("province_code") REFERENCES "public"."geo_provinces"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "geo_communes_district_idx" ON "geo_communes" USING btree ("district_code");--> statement-breakpoint
CREATE INDEX "geo_districts_province_idx" ON "geo_districts" USING btree ("province_code");