-- doc-access-two-axis S-001: replace the single general-access model with two
-- independent axes. Greenfield (no users yet) → schema replace, no data backfill.
--
--  · share_links: DROP the single `role` column; ADD two nullable role columns
--    `workspace_role` + `link_role` (each share_role | null; null = that axis off).
--  · docs: DROP the `general_access` column entirely (the legacy 3-value level is now
--    DERIVED on read via deriveLevel(workspace_role, link_role)).
--  · DROP the now-unused `general_access` enum type.
--
-- The dev/test/demo DBs are reset + reseeded (bun db:seed) — there is nothing to migrate.

ALTER TABLE "share_links" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "workspace_role" "share_role";--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "link_role" "share_role";--> statement-breakpoint
ALTER TABLE "docs" DROP COLUMN "general_access";--> statement-breakpoint
DROP TYPE "public"."general_access";
