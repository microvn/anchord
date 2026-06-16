import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { newId } from "./id";

// Minimal foundational schema for the runnable skeleton: docs + immutable versions
// (owned by render-publish). Feature clusters extend this (annotations, shares,
// api_tokens, notifications, better-auth tables) in their own builds.

// Snowflake string id, generated in JS ($defaultFn) — no Postgres gen_random_uuid(), so the
// schema stays portable (SQLite-ready). Every id + FK column is `text` (see src/db/id.ts).
const id = () => text("id").primaryKey().$defaultFn(() => newId());
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
    // owner_id (auth-routes S-001, C-001/C-007): the authenticated user who FIRST
    // published this doc. references user.id, which is better-auth's TEXT id (NOT
    // uuid) — C-007. NULLABLE: a doc seeded/published without a session has no owner
    // (mirrors the published_by pattern). Immutable in v0 (transfer is v0.5): no
    // update-owner path exists — owner is written once at create.
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    generalAccess: generalAccess("general_access").notNull().default("restricted"),
    // project_id (workspace-project S-003): the project this doc belongs to. The spec
    // said this is "defined in render-publish" but it was never added to the schema;
    // S-003 adds it here. NULLABLE at the column level (a legacy/seeded doc may lack
    // one), but the PUBLISH path always sets it — explicit projectId, else the
    // publisher's default project (C-009 / the MCP-missing-projectId fallback). On a
    // project delete the FK is set null (we block delete of a non-empty project, but
    // set-null keeps the doc reachable if a project ever vanishes another way).
    projectId: text("project_id").references((): any => projects.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [index("doc_slug_idx").on(t.slug), index("doc_project_idx").on(t.projectId)],
);

// ── projects (workspace-project S-003) ─────────────────────────────────────
// A Project groups docs inside the single workspace (Workspace → Project → Doc).
// Any member may create one (C-002 — admin-only is for settings/members, not
// projects). `archived_at` set = hidden from the default browse list (C-005); the
// project's docs stay reachable by direct link. `is_default` marks the per-account
// default project auto-created on join (C-009) — exactly one per account, and it can
// never be archived or deleted (it is the MCP fallback target). `owner_id` is the
// member who created it / whose default project this is (set null on user delete).
//
// Portable on purpose: the "find a user's default project" index is a PLAIN composite
// on (workspace_id, owner_id) — NOT a Postgres partial index — so a future SQLite
// build stays open; uniqueness of the default project is enforced in the service
// (ensureDefaultProject is idempotent), not by a partial-unique DB trick.
export const projects = pgTable(
  "projects",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("projects_workspace_idx").on(t.workspaceId),
    // Find a user's default project (C-009) without a Postgres-only partial index.
    index("projects_workspace_owner_idx").on(t.workspaceId, t.ownerId),
  ],
);

export const docVersions = pgTable(
  "doc_versions",
  {
    id: id(),
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content").notNull(), // HTML/MD text; images live on the assets volume
    contentHash: text("content_hash").notNull(),
    // extracted_text (workspace-project S-005, GAP-003 → publish-time extraction):
    // the plain text derived from this version's content at PUBLISH time (HTML/MD
    // stripped to text; image → its alt/filename). It feeds the full-text search
    // index (C-006) so a search never has to re-render content at query time.
    // NULLABLE: existing/seeded versions predate this column (null = not indexed);
    // new publishes always populate it. PORTABILITY: this is a PLAIN `text` column
    // (portable) — the Postgres-only FTS lives ONLY in the search repo's query +
    // the GIN index DDL (see src/search/search-repo.ts), never in the column type,
    // so a future SQLite build swaps the query for FTS5 with no schema change.
    extractedText: text("extracted_text"),
    // Author who published this version (render-publish S-001). RETYPED uuid→text +
    // FK by auth-routes S-001 (C-007): better-auth user.id is TEXT, not uuid — a
    // uuid column would reject a better-auth id like "u_abc123". Nullable (a
    // version published without a session, or any pre-auth row, has no publisher),
    // set null on user delete. The column is all-null in existing data, so the
    // type change is safe.
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
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
    docId: text("doc_id")
      .notNull()
      .unique() // C-001: one general-access config per doc
      .references(() => docs.id, { onDelete: "cascade" }),
    role: shareRole("role").notNull().default("viewer"),
    guestCommenting: boolean("guest_commenting").notNull().default(false),
    // editors_can_share (sharing C-015 / AS-022): the owner-controlled toggle that
    // lets editors manage sharing (Google-Docs style). Default ON — editors can share
    // unless the owner turns it off. Only the OWNER may flip this; an editor managing
    // sharing (when on) still cannot change the toggle itself.
    editorsCanShare: boolean("editors_can_share").notNull().default(true),
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
    docId: text("doc_id")
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

// ── annotations + comments (annotation-core S-001) ─────────────────────────
// An annotation anchors to a doc (a Version, in the full model) and carries a
// thread of comments. The anchor is stored as jsonb (allowed per CLAUDE.md for
// flexible anchor descriptors): for a text range it holds
// { block_id, text_snippet, offset, length, segments? }. block_id is a POSITIONAL
// hint (C-001, see src/annotation/block-id.ts) — durability across versions rides
// on text_snippet+offset+fuzzy+orphan (C-002, S-005), NOT on a stable block_id.
//
// type:        range | multi_range | block | doc (image-region lands in S-002).
// is_orphaned: set true by re-anchor (S-005) when a block/snippet is lost; the
//              annotation is never deleted, it detaches (C-002).
// status:      unresolved | resolved — the resolve toggle (S-004).
// Portable on purpose (jsonb is the one declared exception); the create-path
// server re-authorization (C-009) + read authz (C-010) live in
// src/annotation/annotation.ts and are unit-tested there. DB/HTTP glue +
// the bridge transport are integration-/FE-verified later.
export const annotationType = pgEnum("annotation_type", [
  "range",
  "multi_range",
  "block",
  "doc",
  // S-006: a suggestion is a suggestion-TYPE annotation. It rides in this same table —
  // the suggestion payload lives in `suggestion` jsonb and its lifecycle in
  // `suggestion_status`, so a suggestion never touches doc content (C-003).
  "suggestion",
]);
export const annotationStatus = pgEnum("annotation_status", ["unresolved", "resolved"]);

// S-006 suggestion lifecycle — DISTINCT from annotationStatus (unresolved|resolved) so
// the two never collide. `stale` is first-class (a drifted `from`, C-011), not an error.
export const suggestionStatus = pgEnum("suggestion_status", [
  "pending",
  "accepted",
  "rejected",
  "stale",
]);

export const annotations = pgTable(
  "annotations",
  {
    id: id(),
    docId: text("doc_id")
      .notNull()
      .references(() => docs.id, { onDelete: "cascade" }),
    type: annotationType("type").notNull(),
    // Anchor descriptor — see Anchor in src/annotation/annotation.ts.
    anchor: jsonb("anchor").notNull(),
    // author_id (annotation-actions S-001 / C-005): the DURABLE creator identity, written
    // AT CREATE from the session actor (createAnnotation / createSuggestion). NULL when the
    // creator is a guest (no account). This is the SINGLE authoritative creator fact for
    // own-vs-others gates (delete-own, owner-no-self-approve) — it is NOT derived from the
    // root comment (which has no uniqueness/ordering guarantee and may not exist at create).
    // Served on the read as `authorId`. FK → user.id (better-auth TEXT id); set null on user
    // delete (mirrors comments.author_id) so a deleted account never orphans the annotation.
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    isOrphaned: boolean("is_orphaned").notNull().default(false),
    status: annotationStatus("status").notNull().default("unresolved"),
    // S-009 / C-015: a label-preset id on a SIGNAL annotation (comment/like/label) — a
    // member of DEFAULT_LABEL_PRESETS, validated server-side at the create boundary (the set
    // is a v0 CONSTANT, not a table; no DB CHECK, kept portable). NULL for ordinary
    // annotations and suggestions; mutually exclusive with `suggestion` (enforced at create).
    label: text("label"),
    // ── S-006 suggestion state (NULL for ordinary annotations) ──
    // The suggestion payload (kind replace|delete, from/to, against_version) as jsonb,
    // and its own lifecycle status, both nullable so a normal annotation carries neither
    // (C-003: a suggestion only ever writes its own row, never doc content).
    suggestion: jsonb("suggestion"),
    suggestionStatus: suggestionStatus("suggestion_status"),
    createdAt: createdAt(),
  },
  (t) => [index("annotations_doc_idx").on(t.docId)],
);

// ── reanchor_ledger (annotation-core S-005, C-012) ─────────────────────────
// The idempotency record for re-anchoring annotations onto a new version. One row per
// (annotation_id, version_id): the outcome (carried|orphaned) + the carried anchor.
// The UNIQUE(annotation_id, version_id) makes a re-run a no-op — the second attempt to
// persist the same pair conflicts, so the ledger never double-applies (C-012). Matches
// ReanchorLedgerEntry in src/annotation/reanchor.ts. version_id is the doc_versions row
// id; no FK on it for now (re-anchor runs OFF the publish path and a version may be
// referenced by ledger entries computed before/after — kept loose + portable).
export const reanchorLedgerStatus = pgEnum("reanchor_ledger_status", ["carried", "orphaned"]);

export const reanchorLedger = pgTable(
  "reanchor_ledger",
  {
    id: id(),
    annotationId: text("annotation_id")
      .notNull()
      .references(() => annotations.id, { onDelete: "cascade" }),
    versionId: text("version_id").notNull(),
    status: reanchorLedgerStatus("status").notNull(),
    // The re-anchored anchor when carried; NULL when orphaned.
    anchor: jsonb("anchor"),
    createdAt: createdAt(),
  },
  (t) => [
    // C-012: one outcome per (annotation, version) — the idempotency backstop.
    uniqueIndex("reanchor_ledger_uq").on(t.annotationId, t.versionId),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    annotationId: text("annotation_id")
      .notNull()
      .references(() => annotations.id, { onDelete: "cascade" }),
    // Self-FK for a flat reply (S-003, C-004 — one level). NULL = top comment.
    parentId: text("parent_id").references((): any => comments.id, { onDelete: "cascade" }),
    // The signed-in author; NULL for a guest comment (S-007), which carries guestName.
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    guestName: text("guest_name"),
    // Optional email a guest may supply with a comment (S-007 / AS-017). NULL when absent.
    guestEmail: text("guest_email"),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("comments_annotation_idx").on(t.annotationId)],
);

// ── notifications (workspace-project S-006) ────────────────────────────────
// The IN-APP channel for "you got a reply" (AS-011 / C-004). One row per recipient
// per notify event: a thread participant or the doc owner gets a row when someone
// ELSE replies (the replier never notifies themselves). The EMAIL channel rides the
// shared MailQueue (src/auth/mail-queue.ts), not this table.
//
// user_id is the RECIPIENT — an account-holder only (a guest has no account, so a
// guest is never an in-app recipient). FK → user.id (better-auth TEXT id), cascade
// on user delete (their notifications go with them). `type` is a pgEnum seeded with
// just 'reply' for now but extensible (mention/resolve/… later) without a code churn.
// `ref_id` is the DEEP-LINK target: the ANNOTATION (thread) id — opening the
// notification takes the user to the thread that got the reply (one ref per the
// data-model note; we deep-link to the thread, not the individual comment). `read`
// drives the unread badge; the (user_id, read) index backs the unread list.
//
// Portable on purpose (no Postgres-only features) so a future SQLite build stays open.
export const notificationType = pgEnum("notification_type", ["reply"]);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    // The recipient (account-holder). Cascade: deleting the user removes their notifications.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: notificationType("type").notNull(),
    // Deep-link target — the annotation (thread) id that received the reply.
    refId: text("ref_id").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_read_idx").on(t.userId, t.read)],
);

// ── workspace + membership (workspace-project S-001) ───────────────────────
// v0 SINGLE workspace = the instance. First-run creates EXACTLY ONE workspaces
// row + the installer as `admin` in workspace_members; everyone who signs up
// afterward is auto-added as `member` (C-001). The "only one row" rule is an
// APPLICATION-layer guard (check-count-in-tx before insert — see
// src/workspace/setup.ts), NOT a Postgres-only partial-unique trick, so a future
// SQLite build stays open. `settings` is jsonb (the one declared exception):
// enabled auth providers + default access + branding.
//
// The membership role is a WORKSPACE role (admin|member) — distinct from the
// per-doc share_role (viewer|commenter|editor) and from docs.owner_id.
export const workspaceRole = pgEnum("workspace_role", ["admin", "member"]);

export const workspaces = pgTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // jsonb (declared exception): { providers, defaultAccess, branding }.
  settings: jsonb("settings").notNull(),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // better-auth user.id is TEXT (not uuid) — C-007 of auth-routes applies here too.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: workspaceRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // A user joins a workspace exactly once.
    uniqueIndex("workspace_members_uq").on(t.workspaceId, t.userId),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

// ── workspace_invitations (workspaces S-004) ───────────────────────────────
// A pending invite to join a workspace by EMAIL. An admin invites an email + role;
// the invitee opens an accept-link and accepts (→ a workspace_members row + status
// accepted) or rejects (status rejected, no membership). The accepting session's
// email MUST match the invited email (C-004). Distinct from doc_members (per-doc
// sharing) — this is workspace-level tenancy membership.
//
// `token` is the accept-link secret (random, stored). `status` tracks lifecycle.
// `expires_at` bounds the invite. Portable (no Postgres-only features) so a future
// SQLite build stays open.
export const invitationStatus = pgEnum("invitation_status", [
  "pending",
  "accepted",
  "rejected",
  "revoked",
]);

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: workspaceRole("role").notNull(),
    token: text("token").notNull().unique(),
    status: invitationStatus("status").notNull().default("pending"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("workspace_invitations_ws_idx").on(t.workspaceId),
    index("workspace_invitations_email_idx").on(t.email),
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
    // workspaces S-003 (C-005): the login-default workspace to land in. NOT the request
    // scope (that is the URL path /api/w/:workspaceId). Nullable: set to the user's own
    // workspace at signup; updated by the switch endpoint. better-auth additionalFields
    // maps this column.
    activeWorkspaceId: text("activeWorkspaceId"),
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
