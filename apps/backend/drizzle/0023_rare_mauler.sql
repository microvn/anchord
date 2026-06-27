DROP INDEX "activity_workspace_created_idx";--> statement-breakpoint
CREATE INDEX "docs_updated_idx" ON "docs" USING btree ("updated_at","id") WHERE "docs"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at","id");--> statement-breakpoint
CREATE INDEX "activity_workspace_created_idx" ON "activity" USING btree ("workspace_id","created_at","id");