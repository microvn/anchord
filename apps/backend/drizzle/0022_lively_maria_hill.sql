CREATE TYPE "public"."project_visibility" AS ENUM('private', 'public');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "visibility" "project_visibility" DEFAULT 'public' NOT NULL;