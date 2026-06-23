-- workspace-notifications S-001: add the four workspace-membership notification types +
-- the refLabel snapshot column. `ADD VALUE IF NOT EXISTS` is idempotent on a crash-restart
-- and forward-only (no down-migration); the new values are NOT used in this same migration
-- (only declared + a nullable column added), so they are safe inside the migrator's tx.
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'workspace_invited';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'workspace_member_joined';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'workspace_member_removed';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'workspace_renamed';--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "ref_label" text;
