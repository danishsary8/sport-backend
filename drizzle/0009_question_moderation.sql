ALTER TABLE "product_questions" ADD COLUMN "moderated_by" uuid;--> statement-breakpoint
ALTER TABLE "product_questions" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_questions" ADD CONSTRAINT "product_questions_moderated_by_users_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;