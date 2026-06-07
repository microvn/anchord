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

// The role granted to "anyone with the link" (sharing S-001). NOT "owner":
// owner is conferred by ownership, never by a link. Roles ordered low→high.
export const shareRole = pgEnum("share_role", ["viewer", "commenter", "editor"]);

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

// share_links (sharing S-001): the general-access config for a doc — the role
// granted to anyone-with-link + the guest-commenting sub-toggle. One row per doc
// (unique docId, C-001): a doc has exactly one general-access config. The actual
// access *level* lives on docs.general_access; this row carries the link-scoped
// role + guest toggle (and, later, S-004's link controls).
//
// password_hash / expires_at / view_limit / view_count are S-004's link controls.
// Added now as NULLABLE so S-004 attaches without a schema migration; they are
// independent of the general-access setting (C-001) and untouched by S-001.
export const shareLinks = pgTable(
  "share_links",
  {
    id: id(),
    docId: uuid("doc_id")
      .notNull()
      .unique() // C-001: one general-access config per doc
      .references(() => docs.id, { onDelete: "cascade" }),
    role: shareRole("role").notNull().default("viewer"),
    guestCommenting: boolean("guest_commenting").notNull().default(false),
    // ── S-004 link controls (nullable; not set by S-001) ──
    passwordHash: text("password_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    viewLimit: integer("view_limit"),
    viewCount: integer("view_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
);

// doc_members (sharing S-003): per-doc membership granted by an email invite.
// An owner invites someone by email + role; if that email already has an account
// the row is ACTIVE immediately (userId set), otherwise it is PENDING (userId null,
// matched by email) and activates when an account for that email is created + verified
// (C-006). Reuses the share_role enum (viewer|commenter|editor) — owner is implicit/
// separate, never an invited role.
//
// Portable on purpose (no Postgres-only features) so a future SQLite build stays open.
// The live cross-module activation (auth's activatePendingInvites drives the concrete
// repo at signup) is integration-verified-later; the row shape + repo logic are
// unit-tested in src/sharing/invite.test.ts.
export const memberStatus = pgEnum("member_status", ["active", "pending"]);

export const docMembers = pgTable(
  "doc_members",
  {
    id: id(),
    docId: uuid("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    // Bound to a user once an account exists; NULL while the invite is pending.
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    // The invited email — the match key for pending invites (normalized lowercase+trim).
    email: text("email").notNull(),
    role: shareRole("role").notNull(),
    message: text("message"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id),
    status: memberStatus("status").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("doc_members_doc_idx").on(t.docId),
    index("doc_members_email_idx").on(t.email),
    index("doc_members_user_idx").on(t.userId),
  ],
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
