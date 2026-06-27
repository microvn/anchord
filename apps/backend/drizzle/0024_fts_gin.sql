-- Full-text search GIN indexes (search-repo.ts portability boundary).
-- Postgres-only — NOT expressible in schema.ts (Drizzle has no GIN/expression-index type);
-- a future SQLite build uses FTS5 instead, so these live ONLY here as raw migration DDL.
-- Each expression must be BYTE-IDENTICAL to the query in src/search/search-repo.ts, or the
-- planner ignores the index: title + comments.body match the bare column; doc_versions matches
-- coalesce(extracted_text,''). to_tsvector('english', ...) is the 2-arg IMMUTABLE form (indexable).
CREATE INDEX IF NOT EXISTS "docs_title_fts_idx" ON "docs" USING gin (to_tsvector('english', "title"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "doc_versions_extracted_text_fts_idx" ON "doc_versions" USING gin (to_tsvector('english', coalesce("extracted_text", '')));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_body_fts_idx" ON "comments" USING gin (to_tsvector('english', "body"));
