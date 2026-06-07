CREATE TYPE "public"."member_status" AS ENUM('active', 'pending');--> statement-breakpoint
CREATE TABLE "doc_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_id" uuid NOT NULL,
	"user_id" text,
	"email" text NOT NULL,
	"role" "share_role" NOT NULL,
	"message" text,
	"invited_by" text NOT NULL,
	"status" "member_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_members" ADD CONSTRAINT "doc_members_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_members" ADD CONSTRAINT "doc_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_members" ADD CONSTRAINT "doc_members_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_members_doc_idx" ON "doc_members" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "doc_members_email_idx" ON "doc_members" USING btree ("email");--> statement-breakpoint
CREATE INDEX "doc_members_user_idx" ON "doc_members" USING btree ("user_id");