import { sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Minimal foundational schema for the runnable skeleton: docs + immutable versions
// (owned by render-publish). Feature clusters extend this (annotations, shares,
// api_tokens, notifications, better-auth tables) in their own builds.

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const docKind = pgEnum("doc_kind", ["html", "markdown", "image"]);
export const generalAccess = pgEnum("general_access", [
  "restricted",
  "anyone_in_workspace",
  "anyone_with_link",
]);

export const docs = pgTable(
  "docs",
  {
    id: id(),
    slug: text("slug").notNull().unique(), // immutable for the doc's lifetime
    title: text("title").notNull(),
    kind: docKind("kind").notNull(),
    generalAccess: generalAccess("general_access").notNull().default("restricted"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [index("doc_slug_idx").on(t.slug)],
);

export const docVersions = pgTable(
  "doc_versions",
  {
    id: id(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(), // HTML/MD text; images live on the assets volume
    contentHash: text("content_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("doc_version_uq").on(t.docId, t.version)],
);
