ALTER TABLE "doc_versions" ADD COLUMN "extracted_text" text;--> statement-breakpoint
-- workspace-project S-005 (C-006): full-text search index over the three match
-- sources — doc title, a version's extracted_text, and comment bodies.
--
-- PORTABILITY BOUNDARY (CLAUDE.md): tsvector/GIN is a Postgres-ism. It is confined
-- to (a) these index definitions and (b) the query in src/search/search-repo.ts.
-- The stored columns (docs.title, doc_versions.extracted_text, comments.body) stay
-- plain portable text; a future SQLite build drops these indexes and swaps the
-- repo query for FTS5 with NO schema change. We compute to_tsvector('english', ...)
-- in the query (matching expression indexes below) rather than adding a generated
-- tsvector column, to keep the column set portable.
CREATE INDEX "docs_title_fts_idx" ON "docs" USING gin (to_tsvector('english', "title"));--> statement-breakpoint
CREATE INDEX "doc_versions_extracted_fts_idx" ON "doc_versions" USING gin (to_tsvector('english', coalesce("extracted_text", '')));--> statement-breakpoint
CREATE INDEX "comments_body_fts_idx" ON "comments" USING gin (to_tsvector('english', "body"));
