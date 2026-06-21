ALTER TABLE "workspaces" ADD COLUMN "creator_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_creator_id_user_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill creator_id = the earliest-joined admin member (the de-facto creator). (workspaces migration note 2026-06-22)
UPDATE "workspaces" w SET "creator_id" = (
  SELECT wm.user_id FROM "workspace_members" wm
  WHERE wm.workspace_id = w.id AND wm.role = 'admin'
  ORDER BY wm.created_at ASC
  LIMIT 1
) WHERE w."creator_id" IS NULL;--> statement-breakpoint
-- Rename auto-created workspaces still literally named 'default' to "<creator display name>'s workspace",
-- clearing the indistinguishable duplicate-"default" collision. Rows whose creator has no name stay 'default'.
UPDATE "workspaces" w SET "name" = u."name" || '''s workspace'
FROM "user" u
WHERE w."creator_id" = u.id AND w."name" = 'default' AND u."name" IS NOT NULL AND u."name" <> '';