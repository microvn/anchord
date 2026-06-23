CREATE TYPE "public"."activity_type" AS ENUM('comment', 'reply', 'resolve', 'publish', 'restore', 'share', 'invite', 'member', 'member_removed', 'workspace_renamed', 'project', 'detached');--> statement-breakpoint
CREATE TABLE "activity" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" "activity_type" NOT NULL,
	"actor_user_id" text,
	"actor_name" text NOT NULL,
	"doc_id" text,
	"project_id" text,
	"version_id" text,
	"comment_id" text,
	"annotation_id" text,
	"summary" text,
	"target" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_annotation_id_annotations_id_fk" FOREIGN KEY ("annotation_id") REFERENCES "public"."annotations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_workspace_created_idx" ON "activity" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_workspace_doc_idx" ON "activity" USING btree ("workspace_id","doc_id");