CREATE TYPE "public"."reanchor_ledger_status" AS ENUM('carried', 'orphaned');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'accepted', 'rejected', 'stale');--> statement-breakpoint
ALTER TYPE "public"."annotation_type" ADD VALUE 'suggestion';--> statement-breakpoint
CREATE TABLE "reanchor_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"annotation_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"status" "reanchor_ledger_status" NOT NULL,
	"anchor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "suggestion" jsonb;--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "suggestion_status" "suggestion_status";--> statement-breakpoint
ALTER TABLE "reanchor_ledger" ADD CONSTRAINT "reanchor_ledger_annotation_id_annotations_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."annotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reanchor_ledger_uq" ON "reanchor_ledger" USING btree ("annotation_id","version_id");