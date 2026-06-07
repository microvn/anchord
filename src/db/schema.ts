import { sql } from "drizzle-orm";
import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
    // Author who published this version (S-001). Nullable + no FK for now: the users
    // table does not exist until the auth cluster; the FK is added there later.
    publishedBy: uuid("published_by"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("doc_version_uq").on(t.docId, t.version)],
);

// ── better-auth tables (auth S-001) ────────────────────────────────────────
// Hand-added to match better-auth's expected schema (getAuthTables(options)):
// user / session / account / verification. better-auth maps its model fields to
// these exact column names (camelCase, e.g. "emailVerified", "userId") by default;
// ids are text (better-auth's default string id), NOT uuid. Drizzle keeps these
// portable (no Postgres-only features) so a future SQLite build stays possible.
// The drizzle adapter (src/auth/auth.ts) reads/writes these.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    // DB-backed session (C-001): each row is a live session; deleting it revokes it.
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
    scope: text("scope"),
    // Hashed email+password credential (better-auth owns hashing) — C-006.
    password: text("password"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);
