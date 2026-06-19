CREATE TYPE "public"."anchor_resolution_method" AS ENUM('blockid', 'exact', 'nearest', 'normalized', 'fuzzy');--> statement-breakpoint
CREATE TYPE "public"."anchor_resolution_status" AS ENUM('anchored', 'orphaned');--> statement-breakpoint
CREATE TABLE "anchor_resolution" (
	"id" text PRIMARY KEY NOT NULL,
	"annotation_id" text NOT NULL,
	"version_id" text NOT NULL,
	"status" "anchor_resolution_status" NOT NULL,
	"method" "anchor_resolution_method",
	"confidence" real,
	"block_id" text,
	"offset" integer,
	"length" integer,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anchor_resolution" ADD CONSTRAINT "anchor_resolution_annotation_id_annotations_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."annotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anchor_resolution_uq" ON "anchor_resolution" USING btree ("annotation_id","version_id");