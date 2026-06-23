import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    // Find a user's default project (C-009): a plain composite index for the lookup.
    index("projects_workspace_owner_idx").on(t.workspaceId, t.ownerId),
    // Exactly one default project per (workspace, owner) — DB-enforced (mcp-roundtrip C-011 /
    // workspace-project C-009). This is the at-most-one half (ensureDefaultProject supplies the
    // at-least-one half); it makes a concurrent first-create race-proof. The `owner_id IS NOT
    // NULL` guard is required because NULLs are distinct in a unique index and a default project
    // always has an owner. A partial UNIQUE index is PORTABLE — SQLite has supported it since
    // 3.8.0 — so it does not violate the CLAUDE.md "avoid Postgres-only features" rule.
    uniqueIndex("projects_default_uq")
      .on(t.workspaceId, t.ownerId)
      .where(sql`${t.isDefault} = true AND ${t.ownerId} IS NOT NULL`),
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
    // capability_token (capability-share-link S-001 / C-001): the high-entropy,
    // crypto-random, URL-safe secret that addresses the doc at /s/<token> when general
    // access is anyone_with_link. NULL when the doc is not link-shared (restricted /
    // anyone_in_workspace). Set/cleared on the access transition (share-token.ts), never
    // derived from the title. Globally UNIQUE — the partial unique index below is the hard
    // guarantee behind the ~128-bit "globally unique" property (a null is exempt: a
    // non-shared doc carries no token, and many nulls must coexist).
    capabilityToken: text("capability_token"),
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
  (t) => [
    // C-001: a capability token is globally unique. PARTIAL unique index (WHERE NOT
    // NULL) so the many non-shared docs (token NULL) coexist while every minted token is
    // unique. Portable: SQLite supports partial indexes too (memory: C-011 decision).
    uniqueIndex("share_links_capability_token_idx")
      .on(t.capabilityToken)
      .where(sql`${t.capabilityToken} IS NOT NULL`),
  ],
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
    // deleted_at (annotation-actions S-004 / C-006): a SOFT-DELETE tombstone, mirroring the
    // dismissed_at precedent (annotation-core S-008). NULL = active; a timestamp = soft-deleted
    // (delete-own by the author, or owner-moderation). The READ-side total-exclusion + terminal
    // guards + restore are S-005; this column + its delete authz are S-004.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // dismissed_at (annotation-core S-008 / C-013): a SOFT-DISMISS marker for a DETACHED
    // (is_orphaned) annotation. NULL = active; a timestamp = dismissed (commenter+ cleared it
    // from the detached list, AS-023). Dismissed rows are EXCLUDED from the active list read
    // (alongside deleted_at) but are NOT hard-deleted — the row is kept. Distinct from
    // deleted_at: dismiss is detached-list housekeeping (any commenter+), delete is an
    // ownership action (own/owner). Additive nullable column, no backfill.
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: createdAt(),
    // updated_at (annotation-core C-017 / mcp-roundtrip AS-008): the monotonic mutation
    // watermark. Set at create (defaultNow → equals created_at) and bumped on EVERY
    // subsequent mutation — resolve/reopen, dismiss, orphan/unorphan, suggestion-decide,
    // re-anchor (carried AND detached), AND when a comment/reply is added to this annotation
    // (the parent bump, so a reply surfaces in the annotation's changed-since query). The
    // repo bumps it EXPLICITLY (not $onUpdate) so the parent-bump-on-reply path can set it
    // without an annotations.set on the same row. A (updated_at, id) pair is the cursor the
    // MCP pull tool returns — a monotonic watermark, never a page offset. NOT NULL, so the
    // lexicographic changed-since compare never has to handle a null.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("annotations_doc_idx").on(t.docId),
    // C-017 / AS-008: backs the changed-since query (doc + (updated_at, id) > watermark,
    // ordered by (updated_at, id)) — the cursor scan stays index-ordered, no full sort.
    index("annotations_doc_updated_idx").on(t.docId, t.updatedAt, t.id),
  ],
);

// ── anchor_resolution (annotation-reanchor S-003, C-005) ───────────────────
// The IMMUTABLE per-(annotation, version) re-anchor outcome — the deepened persistence of
// annotation-core:C-012's ledger that the parent left as [→MANUAL]. One row records, for
// where annotation A lands in version V: the `status` (anchored | orphaned), the winning
// ladder `method` (blockid | exact | nearest | normalized | fuzzy — which C-002 tier won),
// the `confidence` (the matcher's similarity score 0..1), and the RESOLVED SPAN in THIS
// version when anchored (block_id / offset / length, all nullable — null when orphaned).
//
// Versions are immutable, so "where does A land in V" is also immutable: the row is computed
// ONCE and reused (C-005 idempotency). UNIQUE(annotation_id, version_id) is the backstop —
// a second persist for the same pair conflicts (ON CONFLICT DO NOTHING), so re-running
// re-anchor for the same version never rewrites a row and never double-applies. This is also
// the seam a later semantic fallback (Not-in-Scope Stage 2) writes a higher-confidence row into.
//
// `annotations.is_orphaned` is the DERIVED current-version projection of these rows — the rows
// are the truth; is_orphaned mirrors the resolution for the doc's CURRENT version (set by the job).
//
// Portable on purpose (no DB CHECK): the status/method enums are pgEnums + validated at the app
// boundary, consistent with how annotations does status / suggestion_status. version_id has no
// FK (re-anchor runs OFF the publish path; a version may be referenced before/after — kept loose
// + portable).
export const anchorResolutionStatus = pgEnum("anchor_resolution_status", ["anchored", "orphaned"]);
export const anchorResolutionMethod = pgEnum("anchor_resolution_method", [
  "blockid",
  "exact",
  "nearest",
  "normalized",
  "fuzzy",
]);

export const anchorResolution = pgTable(
  "anchor_resolution",
  {
    id: id(),
    annotationId: text("annotation_id")
      .notNull()
      .references(() => annotations.id, { onDelete: "cascade" }),
    versionId: text("version_id").notNull(),
    status: anchorResolutionStatus("status").notNull(),
    // The winning ladder tier (C-002) when anchored; NULL when orphaned (no tier won).
    method: anchorResolutionMethod("method"),
    // The matcher's similarity score 0..1 when anchored; NULL when orphaned.
    confidence: real("confidence"),
    // The resolved span in THIS version when anchored; all NULL when orphaned.
    blockId: text("block_id"),
    offset: integer("offset"),
    length: integer("length"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // C-005: one immutable outcome per (annotation, version) — the idempotency backstop.
    uniqueIndex("anchor_resolution_uq").on(t.annotationId, t.versionId),
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
    body: text("body").notNull(),
    createdAt: createdAt(),
    // updated_at (annotation-core C-017): mutation watermark on the comment row itself.
    // v0 comments are append-only (no edit path), so this equals created_at in practice —
    // it exists for parity with annotations and so a future comment-edit bumps it. The
    // changed-since pull keys on the ANNOTATION's updated_at (a new/edited comment bumps its
    // PARENT annotation in the repo), so a reply surfaces via the annotation, not this column.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
//
// notifications-email S-001 (2026-06-20): extended ADDITIVELY — the legacy `reply` value stays
// valid (existing rows unaffected) and the new event taxonomy joins. High-signal (email + in-app):
// new_feedback, thread_activity, suggestion_decided. Low-signal (in-app only): resolved, detached,
// invited. `reply` is the legacy thread-activity alias kept green until S-002 folds it in. The
// generated migration only APPENDS enum values (no DROP/ALTER of `reply`); plain enum, no
// Postgres-only tricks, so the SQLite door stays open.
//
// workspace-notifications S-001 (2026-06-23): extended ADDITIVELY again with the four
// workspace-membership events — `workspace_invited`, `workspace_member_joined`,
// `workspace_member_removed`, `workspace_renamed`. The migration uses `ADD VALUE IF NOT
// EXISTS` (idempotent, forward-only, no down-migration); the TS union NotificationType is
// hand-synced in lockstep (F3). The doc-share `invited` value is left intact — the new
// `workspace_invited` is a DISTINCT type, not an overload.
export const notificationType = pgEnum("notification_type", [
  "reply",
  "new_feedback",
  "thread_activity",
  "suggestion_decided",
  "resolved",
  "detached",
  "invited",
  "workspace_invited",
  "workspace_member_joined",
  "workspace_member_removed",
  "workspace_renamed",
]);

// ── notification preferences (notification-preferences S-001) ──────────────
// Per-user, per-(type, channel) OVERRIDE rows. A row's PRESENCE means the user changed
// that toggle away from its matrix default; ABSENCE means the matrix default applies
// (so only changed toggles are ever stored — F11 future-type-defaults-on falls out for
// free, no per-user baseline). The supported-channel matrix (src/notify/preferences-matrix.ts)
// is the single source of truth for which (type, channel) pairs are SUPPORTED, default-on, or
// LOCKED; the write API refuses an unsupported OR a locked-disable pair (AS-003/AS-015), so a
// `{detached, in_app, false}` row can never exist. `channel` is its own small enum (in_app|email)
// — the in-app/email split is preference-specific and not the notification_type taxonomy.
//
// UNIQUE(user_id, type, channel): one override per pair (the upsert target — a concurrent write
// of the same pair collapses to one row, ON CONFLICT DO UPDATE). Cascade on user delete.
// Portable on purpose (no Postgres-only features) so a future SQLite build stays open.
export const notificationChannel = pgEnum("notification_channel", ["in_app", "email"]);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: notificationType("type").notNull(),
    channel: notificationChannel("channel").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // One override per (user, type, channel) — the upsert key (C-005 caller-scoped writes
    // upsert here). Makes a concurrent double-write of the same pair race-proof.
    uniqueIndex("notification_preferences_uq").on(t.userId, t.type, t.channel),
    index("notification_preferences_user_idx").on(t.userId),
  ],
);

// ── notification settings (notification-preferences S-001) ─────────────────
// The per-user MASTER email switch (C-001). Modeled as a dedicated one-row-per-user table
// (cleaner than overloading the per-(type,channel) override rows with a sentinel `type`, which
// the notification_type enum has no room for). `email_enabled` default true = email on until the
// user opts out of ALL email. ABSENCE of a row means the default (email on). S-001 only STORES +
// READS it; S-002 enforces the suppression at delivery (and the locked in-app notices still
// deliver regardless — F6). UNIQUE(user_id) — at most one settings row per user.
export const notificationSettings = pgTable(
  "notification_settings",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    emailEnabled: boolean("email_enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [uniqueIndex("notification_settings_user_uq").on(t.userId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    // The recipient (account-holder). Cascade: deleting the user removes their notifications.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: notificationType("type").notNull(),
    // Deep-link target — the annotation (thread) id that received the reply, OR the
    // workspace id for a workspace-membership row (workspace-notifications S-001).
    refId: text("ref_id").notNull(),
    // workspace-notifications S-001 (F1): a human-readable display label SNAPSHOTTED at emit
    // time, so the bell renders without a live join that could leak a workspace's CURRENT name
    // to a since-removed member (and so it survives a membership delete). For workspace_invited
    // this is the workspace name. NULL for annotation/doc rows (they enrich via refId→docs).
    refLabel: text("ref_label"),
    // notifications-email S-006 (AS-027/AS-028, panel enrichment 2026-06-21): the TRIGGERING
    // comment for a comment-type row (reply/new_feedback/thread_activity). Set at emit; NULL for
    // non-comment types and (via set-null) when the comment is later removed — the read then
    // degrades to the generic per-type summary (C-014). The panel joins it for actorName + snippet.
    commentId: text("comment_id").references(() => comments.id, { onDelete: "set null" }),
    read: boolean("read").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_read_idx").on(t.userId, t.read)],
);

// ── activity (workspace-activity S-001) ────────────────────────────────────
// An append-only workspace event log: every comment / reply / resolve / publish /
// restore / share / invite / member-join / member-removed / workspace-rename /
// project-create / detach across the workspace, read back through a workspace-scoped,
// paginated, recent-first feed (C-007). DISTINCT from `notification_type` (notifications
// are per-recipient; activity is the complete workspace log) — its own pgEnum.
//
// IMMUTABLE / APPEND-ONLY (C-001): deleting an underlying object does NOT delete its
// activity row. `comment_id`/`annotation_id` are SET NULL on delete so the row survives,
// but `doc_id` is RETAINED (never set-null) on a doc delete — nulling it would reclassify
// the row as a workspace-level event (doc_id IS NULL) and leak a `restricted` doc's event
// to all members (F-1). A deleted doc's event keeps its doc_id so the read-time visibility
// filter (S-002) still gates it.
//
// `actor_user_id` is NULLABLE (the System actor + no-account guests have none); `actor_name`
// is the REQUIRED denormalized display name resolved per-emit (the session carries only the
// user id). `actor_name`/`summary`/`target` are PLAIN TEXT — never HTML (F-12 / guest-name
// defence-in-depth; the FE renders them as escaped text). `meta` is jsonb for type-specific
// fields (publish from/to/adds/dels, restore restored/as, detached count, share access/role,
// invite role/pending).
//
// Portable on purpose (no Postgres-only features): the type enum is a plain pgEnum + the two
// composite indexes are plain B-trees, so a future SQLite build stays open.
export const activityType = pgEnum("activity_type", [
  "comment",
  "reply",
  "resolve",
  "publish",
  "restore",
  "share",
  "invite",
  "member",
  "member_removed",
  "workspace_renamed",
  "project",
  "detached",
]);

export const activity = pgTable(
  "activity",
  {
    id: id(),
    // The owning workspace — resolved at emit from the target doc's project → workspace
    // (C-008 cross-workspace isolation). Cascade on workspace delete.
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: activityType("type").notNull(),
    // The acting account; NULL for the System actor and no-account guests.
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    // Denormalized display name (required, PLAIN TEXT — F-12).
    actorName: text("actor_name").notNull(),
    // Nullable targets. doc_id is NOT set-null on doc delete (RETAINED, C-001/F-1) — a
    // doc-scoped event keeps its doc_id so the read-time filter still gates it; doc_id IS
    // NULL means a genuinely workspace-level event, never a deleted doc.
    docId: text("doc_id"),
    projectId: text("project_id"),
    versionId: text("version_id"),
    // Deep-link refs — SET NULL on delete so the event row survives (C-001).
    commentId: text("comment_id").references(() => comments.id, { onDelete: "set null" }),
    annotationId: text("annotation_id").references(() => annotations.id, { onDelete: "set null" }),
    // The sentence fragments a row renders (plain text, like actor_name).
    summary: text("summary"),
    target: text("target"),
    // jsonb (declared exception): type-specific fields (publish from/to/adds/dels, etc.).
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [
    // C-007: the recent-first feed scan — workspace + created_at.
    index("activity_workspace_created_idx").on(t.workspaceId, t.createdAt),
    // The access-filtered member query (S-002) + the detail "more on this doc" (S-004).
    index("activity_workspace_doc_idx").on(t.workspaceId, t.docId),
  ],
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
  // The account that created this workspace (workspaces:C-001/AS-006). Nullable + `set null`
  // on the creator's deletion so the workspace survives. The consumer marks "mine" by
  // creatorId === me (no longer inferred from name+role).
  creatorId: text("creator_id").references(() => user.id, { onDelete: "set null" }),
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

// ── api_tokens (mcp-roundtrip S-001) ───────────────────────────────────────
// A personal access token (PAT) authenticates an agent on the /mcp endpoint AS the
// owning user, bound to ONE workspace and a scope set (C-001/C-008). The plaintext
// token (prefix `anch_pat_`) is shown ONCE at creation and never stored in clear:
// only the HMAC-SHA256(APP_SECRET, token) hash is persisted (peppered — a stolen DB
// alone can't validate guesses — and INDEXED for O(1) lookup on every JSON-RPC
// request; NOT argon2/bcrypt, which can't be indexed). See src/mcp/token.ts.
//
// `scopes` is the granted scope set, stored as jsonb (the declared exception) — a
// subset of the 6 scopes docs:read/write, annotations:read/write, projects:read/write.
// `revoked_at`/`expires_at` are nullable; an ACTIVE token is revoked_at IS NULL AND
// (expires_at IS NULL OR expires_at > now). `last_used_at` is bumped throttled
// (~once/min/token — C-008) so read-only calls stay cheap.
//
// Portable on purpose (no Postgres-only features) so a future SQLite build stays open;
// the per-user active-token cap (C-007) is an application-layer count-in-tx guard, not
// a partial-unique DB trick.
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // HMAC-SHA256(APP_SECRET, plaintext) base64url — unique + indexed for O(1) lookup.
    tokenHash: text("token_hash").notNull().unique(),
    name: text("name").notNull(),
    // jsonb (declared exception): the granted scope set, e.g. ["docs:read","docs:write"].
    scopes: jsonb("scopes").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("api_tokens_user_idx").on(t.userId),
    // O(1) hash lookup on every MCP request (C-008).
    index("api_tokens_hash_idx").on(t.tokenHash),
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
