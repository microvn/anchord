CREATE TYPE "public"."doc_kind" AS ENUM('html', 'markdown', 'image');--> statement-breakpoint
CREATE TYPE "public"."general_access" AS ENUM('restricted', 'anyone_in_workspace', 'anyone_with_link');--> statement-breakpoint
CREATE TABLE "doc_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"kind" "doc_kind" NOT NULL,
	"general_access" "general_access" DEFAULT 'restricted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_version_uq" ON "doc_versions" USING btree ("doc_id","version");--> statement-breakpoint
CREATE INDEX "doc_slug_idx" ON "docs" USING btree ("slug");