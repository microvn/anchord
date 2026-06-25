ALTER TYPE "public"."activity_type" ADD VALUE 'doc_deleted';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'doc_restored';--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "deleted_workspace_id" text;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_deleted_workspace_id_workspaces_id_fk" FOREIGN KEY ("deleted_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docs_active_idx" ON "docs" USING btree ("project_id") WHERE "docs"."deleted_at" IS NULL;