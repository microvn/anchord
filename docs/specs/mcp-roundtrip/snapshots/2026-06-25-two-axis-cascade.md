# Snapshot: mcp-roundtrip
**Date:** 2026-06-25
**Ref:** doc-access-two-axis cascade
**Reason:** M6 — constraints/data-model superseded by the two-axis access model (C-006 MCP publish default)

---

# Spec: mcp-roundtrip

**Created:** 2026-06-07
**Last updated:** 2026-06-23
**Status:** Draft
**Snapshot limit:** 8

## Overview

MCP server (same backend process, Streamable HTTP at `/mcp`) for agents: publish docs
(create/update), read/list/search, manage projects (list/read/create), pull annotations back
to keep editing, read comment threads, and reply/resolve. Agents authenticate with a
workspace-scoped personal access token (PAT) in a bearer header — the token carries its one
workspace, so the endpoint needs no workspace in the path. Closes the loop agent → annotator → agent.

## Data Model

- **api_tokens**: `id` (snowflake text), `user_id` (FK `user.id`), `workspace_id` (FK — the
  one workspace this token acts in; the server derives the request's workspace from this, so
  the `/mcp` endpoint carries no workspace), `token_hash` (HMAC-SHA256 keyed with `APP_SECRET`
  — peppered, so a stolen DB alone can't validate guesses; an indexed column for O(1) lookup;
  compared with a constant-time check; reuse `apps/backend/src/auth/invite-token.ts`. NOT
  argon2/bcrypt here — a per-row salted KDF can't be indexed, turning every MCP call into a
  full-table KDF scan), `name`, `scopes` (a set drawn from
  `docs:read`, `docs:write`, `annotations:read`, `annotations:write`, `projects:read`,
  `projects:write`), `last_used_at`, `expires_at` (nullable), `created_at`, `revoked_at`
  (nullable). The plaintext token (prefix `anch_pat_`) is shown once at creation and never
  stored in clear.
- Reuse doc/version/annotation/comment; no separate model for content. `pull_annotations`
  reads `annotation-core`'s actual shape — anchor jsonb, the status fields, and the
  suggestion payload (see C-004).

## Stories

### S-001: Authenticate agent with a workspace-scoped token (P0)

**Description:** As a user, I create (and revoke) a personal access token, bound to one
workspace and a set of scopes, so an agent can call MCP under my identity.
**Source:** docs/explore/mcp-roundtrip.md#decisions (item 1 agent auth, item 2 transport);
conversation 2026-06-19 (workspace-in-path endpoint, workspace-scoped + granular token).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/backend/src/db/schema.ts, apps/backend/src/mcp/ (server mount at /mcp, token issuance + verify), apps/backend/package.json (pin @modelcontextprotocol/sdk)
- `autonomous:` checkpoint
- `verify:` create a workspace-scoped token → agent calls a tool on /mcp OK (acts in the token's workspace); revoke → call rejected.
- `note:` FIRST deliverable is a de-risking spike — prove `@modelcontextprotocol/sdk`
  `StreamableHTTPServerTransport` can be driven from an Elysia route under Bun (the SDK is
  written against Node `IncomingMessage`/`ServerResponse`; Elysia/Bun gives WHATWG
  `Request`/`Response` — a request/response adapter is the deliverable), OR hand-roll the
  JSON-RPC + SSE framing (C-005 "native framing" half-implies this). Not assumed reuse.

**Acceptance Scenarios:**

AS-001: Create a token and call MCP successfully
- **Given:** a user creates a PAT bound to workspace W with scopes docs:read + docs:write
- **When:** an agent connects to /mcp with the token in the bearer header (Streamable HTTP) and
  completes the MCP handshake — `initialize`, then `tools/list`, then `tools/call` for a tool
- **Then:** `initialize` returns the server's serverInfo + capabilities, `tools/list` returns the
  `anchord_*` tools, and the `tools/call` executes under that user's identity, scoped to the
  token's workspace W, returning an MCP content-block result
- **Data:** valid token, workspace W
- **Setup:** user is a member of workspace W

AS-002: Wrong/revoked token is rejected
- **Given:** a revoked token (or a wrong token string)
- **When:** an agent calls MCP with that token
- **Then:** the call is rejected with a clear auth error
- **Data:** token revoked

AS-011: A call missing the tool's scope is rejected
- **Given:** a token bound to workspace W with only docs:read
- **When:** an agent calls a write tool (create_document) with it
- **Then:** the call is rejected with a clear scope error and no doc is created
- **Data:** read-only token; create_document attempt

AS-020: Listing tokens never reveals the secret
- **Given:** a user has created 2 PATs
- **When:** the user lists their tokens in Developer settings (the web surface, not the MCP transport)
- **Then:** each token shows name, workspace, scopes, last-used, and expiry plus only the
  `anch_pat_` prefix — the full token and its stored hash are never returned
- **Data:** 2 tokens
- **Setup:** the user owns the tokens

AS-021: Revoke a token
- **Given:** a user has an active PAT
- **When:** the user revokes it in Developer settings
- **Then:** the token is marked revoked and no longer appears among the user's active tokens
  (subsequent MCP calls with it are rejected — AS-002/AS-010)
- **Data:** 1 active token
- **Setup:** the user owns the token

AS-022: Revoking a token takes effect mid-session
- **Given:** an agent has an open Streamable HTTP session authenticated with token T
- **When:** the owner revokes T, then the agent issues its next tool call on the same open stream
- **Then:** that next call is rejected (the token is re-validated on every JSON-RPC request, not
  only at session open)
- **Data:** open session + revoke
- **Setup:** token T valid at session open

AS-023: An MCP tool response is raw JSON-RPC, not enveloped
- **Given:** the MCP server mounted at /mcp (outside any enveloped route group)
- **When:** an agent calls any tool
- **Then:** the response is raw JSON-RPC, NOT wrapped in the API success/error envelope
- **Data:** any valid tool call
- **Setup:** authenticated token

AS-024: Exceeding the per-token rate limit is throttled
- **Given:** a token issuing requests above its per-token rate limit (default 60/min, tunable)
- **When:** it exceeds the limit within the window
- **Then:** further calls on that token are throttled with a clear rate-limit error
- **Data:** burst beyond the threshold
- **Setup:** authenticated token

AS-025: Minting beyond the per-user active-token cap is refused
- **Given:** a user already at the per-user active-token cap (default 10)
- **When:** they try to create another token
- **Then:** the request is refused (so the per-token limit can't be bypassed by minting tokens)
- **Data:** user at the cap
- **Setup:** existing active tokens at the cap

AS-030: A CLI MCP client that sends no Origin header connects
- **Given:** a valid token and an agent CLI client (claude mcp / Cursor / Codex) that sends NO
  Origin header (non-browser clients omit it)
- **When:** the client calls /mcp (handshake + tool call) with the bearer token
- **Then:** the request is accepted and executes — an absent/missing Origin is allowed (the
  DNS-rebinding guard targets browser clients, which always send an Origin)
- **Data:** request with no Origin header + valid token
- **Setup:** the configured base-URL origin allowlist is non-empty

AS-031: A present but non-allowlisted Origin is rejected
- **Given:** a request carrying an Origin header whose value is NOT the configured base-URL origin
  (a `null` Origin counts as present-and-disallowed)
- **When:** it calls /mcp
- **Then:** the call is rejected (DNS-rebinding guard) before any tool runs
- **Data:** Origin "https://evil.example" (and the literal `null`) + valid token
- **Setup:** the configured base-URL origin allowlist is non-empty

### S-002: Publish via MCP — create & update (P0)

**Description:** As an agent, I create a new doc (receiving docId/slug) and update an existing
doc (appending a new version).
**Source:** docs/explore/mcp-roundtrip.md#decisions (item 3 publish tools).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/mcp/tools/ (write tools over publish/version services), apps/backend/src/db/schema.ts (UNIQUE backstops)
- `autonomous:` checkpoint
- `verify:` anchord_create_document → returns docId/slug + v1 in the token's workspace; anchord_update_document(docId) → v2 appears.

**Acceptance Scenarios:**

AS-003: create_document creates doc + slug + version 1
- **Given:** an agent authenticated with a docs:write token bound to workspace W
- **When:** it calls `anchord_create_document(content, format, title?, projectId?)`
- **Then:** a doc is created in workspace W with an immutable slug + version 1,
  general_access = **the workspace's `settings.defaultAccess`** (default `anyone_in_workspace`,
  `workspaces`:C-007 — so W's members can see the agent-created doc; NO longer hard-coded
  `restricted`), placed in the token-owner's default project in W when projectId is missing;
  returns `{ docId, slug, url }`
- **Data:** HTML content + title "Payment Spec", no projectId passed; W `defaultAccess = anyone_in_workspace` → new doc `general_access = anyone_in_workspace`
- **Setup:** token-owner has a default project in W

AS-004: update_document appends a new version
- **Given:** a doc already exists (docId) and the agent has editor+ rights on it
- **When:** it calls `anchord_update_document(docId, content)`
- **Then:** a new version is appended (no overwrite) and re-anchor is triggered (versioning/annotation)
- **Data:** docId + edited content

AS-005: update_document with nonexistent docId / no permission is rejected
- **Given:** an agent calls update with a nonexistent docId, or without editor rights
- **When:** it executes
- **Then:** the call is rejected; the error suggests create_document if a new doc is wanted
- **Data:** unknown docId / token-owner has viewer rights only

AS-018: create_document honors an explicit projectId
- **Given:** an agent with a docs:write token and a projectId the owner can write to in workspace W
  (e.g. obtained from anchord_list_projects / anchord_create_project)
- **When:** it calls `anchord_create_document(content, format, projectId)`
- **Then:** the doc is created inside that project (not the default project)
- **Data:** valid projectId in W
- **Setup:** the project exists in W and the owner has write rights on it

AS-019: create_document with a foreign/invalid projectId is rejected
- **Given:** an agent passes a projectId that doesn't exist or belongs to another workspace/owner
- **When:** it calls `anchord_create_document(content, format, projectId)`
- **Then:** the call is rejected and no doc is created (never silently falls back to the default project)
- **Data:** projectId that is not an active project in the token's workspace

AS-026: Concurrent update_document on one doc produces strictly sequential versions
- **Given:** a doc at version N
- **When:** two update_document calls on that same doc execute concurrently
- **Then:** the doc ends at versions N+1 then N+2 — never two rows numbered N+1
- **Data:** 2 concurrent updates on one docId
- **Setup:** doc exists at version N, agent has editor+ rights

AS-027: Concurrent first create_document yields exactly one default project
- **Given:** a workspace where the token-owner has no default project yet
- **When:** two create_document calls (no projectId) execute concurrently
- **Then:** exactly one default project is created for the owner in that workspace; both docs land in it
- **Data:** 2 concurrent creates in an empty workspace
- **Setup:** owner is a member of W with no default project

AS-028: A failed re-anchor never leaves annotations mis-anchored
- **Given:** update_document appends version N+1 and the async re-anchor then fails/crashes mid-run
- **When:** the doc is read at N+1
- **Then:** affected annotations remain in their PREVIOUS anchored state (never a half-anchored
  state), and re-anchor is retried to completion
- **Data:** update + induced re-anchor failure
- **Setup:** doc with annotations, re-anchor per annotation-core C-012

### S-003: Read via MCP — list / read / search (P1)

**Description:** As an agent, I list, read, and search docs within the token-owner's
permission scope in the token's workspace.
**Source:** docs/explore/mcp-roundtrip.md#decisions (item 3 read).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/mcp/tools/ (read tools over browse/search)
- `autonomous:` true

**Acceptance Scenarios:**

AS-006: list/read/search within the permission scope
- **Given:** the token-owner has rights on some docs in workspace W
- **When:** an agent calls `anchord_list_documents` / `anchord_read_document(idOrSlug)` /
  `anchord_search_documents(query)` (list/search paginated by page + limit)
- **Then:** only docs the token-owner has rights to in the token's workspace are returned; docs
  outside the scope do not appear. (`anchord_list_documents` sources rows from a workspace-wide
  accessible-docs read — a NEW backend query, not the per-project union the web FE assembles
  client-side; verify search returns `{items, pagination}` before relying on page+limit.)
- **Data:** query matches docs both inside and outside the scope

AS-029: A workspace-bound token must not surface another workspace's docs
- **Given:** the token-owner is a member of workspaces W1 and W2, with a token bound to W1, and
  an `anyone_in_workspace` doc exists in W2 the owner could otherwise see
- **When:** an agent calls list/search/read with the W1 token
- **Then:** the W2 doc never appears (every membership/browse check is parameterized by the
  token's workspace_id — the cross-tenant binding is a hard invariant)
- **Data:** anyone_in_workspace doc in W2
- **Setup:** owner ∈ W1 and W2; token bound to W1

### S-004: Pull annotations & read comments (P0)

**Description:** As an agent, I pull a doc's annotations to locate and edit them in my own
source, and read full comment threads.
**Source:** docs/explore/mcp-roundtrip.md#decisions (item 3 pull annotations); conversation
2026-06-19 (pull payload matches annotation-core; list_comments convenience).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/mcp/tools/ (pull over annotation-core model)
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: pull_annotations returns enough context to locate and apply
- **Given:** a doc has annotations (including resolved, orphaned, dismissed) and a replace suggestion
- **When:** an agent calls `anchord_pull_annotations(docId, { cursor?, status?, includeOrphaned?,
  includeDismissed?, includeDeleted?, type? })` — the filter params are OPTIONAL; calling with
  NO filter (just docId) is the default
- **Then:** with NO filter, for EVERY annotation it returns the comment thread + status
  (unresolved/resolved, is_orphaned, dismissed, deleted) + suggestion (`{kind: replace|delete,
  from, to?, againstVersion}` with its suggestion_status pending/accepted/rejected/stale) + anchor
  (`{blockId, textSnippet, offset, length?, segments?, region?}` — `segments` carries the full
  multi_range anchor, so a multi_range annotation is not truncated to its first segment) —
  enough to locate and apply in source; when a filter IS supplied (e.g. `status: unresolved`,
  `includeDeleted: false`, `type: suggestion`) only annotations matching it are returned, the
  per-annotation payload shape unchanged (C-004)
- **Data:** doc has 1 comment + 1 replace suggestion + 1 orphaned + 1 multi_range; one pull with
  no filter (all 4 returned) and one with `status: unresolved` + `includeOrphaned: false`
- **Setup:** token has annotations:read

AS-008: pull only fetches annotations changed since the cursor
- **Given:** an agent pulled earlier and kept the returned cursor — a monotonic
  `(updated_at, snowflake id)` watermark (not a page offset), so two rows sharing an
  `updated_at` are neither skipped nor repeated
- **When:** it calls pull again with that cursor
- **Then:** only annotations/comments whose `(updated_at, id)` is greater than the cursor are
  returned — including ones that *changed* (resolve/reopen/dismiss/orphan/suggestion-decide,
  re-anchor, reply), not only newly created — with no repeats of already-handled ones
- **Data:** previous cursor + 2 new comments + 1 since-resolved annotation
- **Setup:** depends on the annotation-core `updated_at` + changed-since query (GAP-006)

AS-013: list_comments returns a doc's comment threads
- **Given:** a doc has several annotations each with a comment thread, token has annotations:read
- **When:** an agent calls `anchord_list_comments(docId)` (paginated by page + limit)
- **Then:** the doc's comment threads (flat, one reply level) are returned
- **Data:** doc with 3 threads

AS-010: token hashed + pull authorize per-doc [harden H4]
- **Given:** a token whose owner has rights on doc A, not on doc B (restricted)
- **When:** an agent calls `anchord_pull_annotations(B)`, and the token storage is observed
- **Then:** pull(B) is rejected (authorize per-doc by owner); the token is stored as a hash,
  no plaintext exposed; revoking the token rejects all subsequent calls
- **Data:** token-owner ∉ rights on doc B

### S-005: Write back — reply & resolve (P1)

**Description:** As an agent, after handling feedback I reply and mark it resolved.
**Source:** docs/explore/mcp-roundtrip.md#decisions (item 3 write back).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/mcp/tools/ (write-back over annotation/comment services)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: reply_comment and resolve_comment
- **Given:** an annotation has a comment, the token has annotations:write on the doc
- **When:** an agent calls `anchord_reply_comment(commentId, body)` then
  `anchord_resolve_comment(annotationId)`
- **Then:** the reply is added to the thread (flat) and the annotation becomes resolved
- **Data:** reply "changed to 48h in v2" + resolve

### S-006: Manage projects via MCP — list / read / create (P1)

**Description:** As an agent, I list and read projects in my token's workspace and create a
project, so I can organize the docs I publish (and pass a real projectId to create_document).
**Source:** conversation 2026-06-19 (project read+create resolves the create_document
`projectId?` inconsistency — v0 had no way to discover/create a project).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/mcp/tools/ (project tools over the workspace-project service)
- `autonomous:` true

**Acceptance Scenarios:**

AS-014: list_projects returns the workspace's active projects
- **Given:** the token-owner is a member of workspace W (token has projects:read)
- **When:** an agent calls `anchord_list_projects` (paginated by page + limit)
- **Then:** the active projects of W are returned (workspace-member visibility — projects have
  no per-owner ACL in v0, matching the web ProjectsScreen); projects of other workspaces never appear
- **Data:** W with several active projects + a project in another workspace

AS-015: create_project creates a project in the workspace
- **Given:** an agent with a projects:write token bound to workspace W
- **When:** it calls `anchord_create_project(name)`
- **Then:** a project is created in W owned by the token-owner; returns `{ projectId, name }`
  (usable as the projectId for create_document)
- **Data:** name "Payments revamp"

AS-016: create_project without projects:write is rejected
- **Given:** a token without the projects:write scope
- **When:** an agent calls `anchord_create_project(name)`
- **Then:** the call is rejected with a clear scope error and no project is created
- **Data:** read-only token

AS-017: read_project returns a project in the token's workspace
- **Given:** project P is an active project in the token's workspace W (token has projects:read)
- **When:** an agent calls `anchord_read_project(projectId)` (by id — projects have no slug)
- **Then:** P is returned; a projectId from another workspace is rejected, not disclosed
- **Data:** P in W + a projectId from another workspace

## Constraints & Invariants

- C-001: A token authenticates as the owning user; it is bound to one workspace and carries a
  scope set; the server derives the request's workspace from the token and re-validates the
  token (hash lookup + not-revoked + not-expired) on EVERY JSON-RPC request (not only at session
  open). Authorization is a per-RESOURCE gate after the scope check — no tool relies on scope
  alone: docs → `resolveAccess`; projects → workspace-membership; list/search → the
  access-filtered repo with a workspace-correct membership check. A revoked/wrong token, or a
  call lacking the tool's scope → rejected. (AS-001, AS-002, AS-011, AS-022)
- C-002: create → immutable slug + version 1 + returns docId; update → append version
  (no overwrite), requires editor+ rights. (AS-003, AS-004, AS-005)
- C-003: list/read/search return only docs the token-owner has rights to. (AS-006)
- C-004: pull_annotations returns, per annotation, the comment thread + full status
  (unresolved/resolved, is_orphaned, dismissed, deleted) + suggestion (`{kind: replace|delete,
  from, to?, againstVersion}` + suggestion_status pending/accepted/rejected/stale) + anchor
  (`{blockId, textSnippet, offset, length?, segments?, region?}` — `segments` is required for
  multi_range) — enough to locate and apply. The tool accepts OPTIONAL filter params the calling
  model supplies from the user's request — `status` (unresolved | resolved), `includeOrphaned` /
  `includeDismissed` / `includeDeleted` (each defaulting to **true**), and `type` (range |
  multi_range | block | doc | suggestion). With NO filter the default is unchanged — every
  annotation + its status flags is returned (full fidelity, so incremental change-tracking under
  AS-008 still surfaces resolve/dismiss/orphan transitions). A supplied filter narrows the set
  server-side; it composes with the `cursor` (the agent owns the trade-off — a filtered
  incremental pull will not surface a row that no longer matches the filter, which is the agent's
  explicit choice, not a silent server drop). The MCP server exposes the capability + describes
  it; WHICH filter to send is the model's decision at call time. (AS-007)
- C-005: Transport is **Streamable HTTP MCP** at `/mcp` (a single endpoint; the token carries its
  workspace, so no workspace is in the path) — a real MCP server implementing the protocol
  handshake: `initialize` (returns serverInfo + capabilities), `tools/list` (the `anchord_*` tools
  with their input schemas), and `tools/call` (dispatch by `params.name`, returns MCP content
  blocks). The Origin header is validated **only when present**: a present Origin not in the
  allowlist (= the configured base-URL origin) is rejected (DNS-rebinding — a malicious browser
  page always sends an Origin); an **absent/missing Origin is ALLOWED** so non-browser CLI MCP
  clients (claude mcp, Cursor, Codex — which send no Origin) can connect. The endpoint is exempt
  from the API envelope — but exemption is by mount point: the envelope is opt-in via
  `apiEnvelope()`, so `/mcp` MUST be mounted OUTSIDE any enveloped group (and outside the shared
  parent whose scoped hooks propagate); responses are raw JSON-RPC. (AS-001, AS-023, AS-030, AS-031)
- C-006: Visibility is NOT *set* via MCP in v0 (no tool param chooses the access level — set_access
  stays v0.5). Instead, a doc an agent creates INHERITS the token's workspace `settings.defaultAccess`
  (default `anyone_in_workspace`, `workspaces`:C-007) — the same shared-group-space default as
  web/UI publish (sharing-permissions:C-018, render-publish:C-011), NOT hard-coded `restricted`.
  Placement: an explicit `projectId` the owner can write to in the token's workspace is honored; a
  foreign/invalid projectId is rejected (never silent fallback); a missing projectId → the
  token-owner's default project in the token's workspace. (AS-003, AS-018, AS-019)
- C-007: MCP has per-token rate-limiting with a concrete default of 60 requests/min/token
  (tunable), PLUS a per-user active-token cap (default 10) so the per-token limit can't be
  bypassed by minting tokens. The v0 limiter is in-process/in-memory (acceptable for a
  single-box self-host, documented); durable backing → v0.5. (AS-024, AS-025)
- C-008 [harden H4]: api_tokens stored HASHED as `HMAC-SHA256(APP_SECRET, token)` (peppered,
  indexed, constant-time compare — see Data Model), prefix `anch_pat_`, shown once at creation,
  workspace-bound, scoped (`docs:read/write`, `annotations:read/write`, `projects:read/write`),
  individually revocable, with `last_used_at` (updated throttled/coalesced — at most ~once per
  minute per token, so read-only calls stay cheap) + optional expiry; listing tokens never
  returns the full token or its hash (metadata + prefix only); pull/read/write authorize
  per-doc/per-annotation like the web path, by the owner token. (AS-010, AS-011, AS-020, AS-021)
- C-009: Each MCP tool requires the matching token scope — create/update doc need `docs:write`;
  list/read/search docs need `docs:read`; pull_annotations/list_comments need `annotations:read`;
  reply/resolve need `annotations:write`; list_projects/read_project need `projects:read`;
  create_project needs `projects:write`. A call missing its scope is rejected. (AS-011, AS-016)
- C-010: Project tools — list/read return the token's workspace's active projects to any member
  of that workspace (workspace-member visibility; projects have no per-owner ACL in v0, matching
  the web app); a project from another workspace is never returned/disclosed. create_project
  makes a project in the token's workspace owned by the token-owner. (AS-014, AS-015, AS-017)
- C-011: Write-path concurrency/atomicity — version creation is serialized per-doc (advisory
  lock or `SELECT … FOR UPDATE` on the doc row) with a `UNIQUE(doc_id, version)` backstop, so
  concurrent update_document produces strictly sequential versions (N+1, N+2), never two N+1.
  Default-project resolution is split into two guarantees that together yield **exactly one**
  default per owner per workspace: (a) **at-most-one** is DB-enforced by a partial-unique index
  `UNIQUE(workspace_id, owner_id) WHERE is_default AND owner_id IS NOT NULL` (the `owner_id IS NOT
  NULL` guard is required because NULLs are distinct in a unique index, and a default project
  always has an owner) — this is the race-proofing under concurrent create; (b) **at-least-one**
  is service-enforced by `ensureDefaultProject` find-or-create (lazily, on the first projectId-less
  create_document). On the concurrent-create race the index rejects the second insert and the
  service reads back the winner. The partial-unique index is portable — SQLite has supported
  partial UNIQUE indexes since 3.8.0 — so it does NOT violate the CLAUDE.md "avoid Postgres-only
  features" rule; it **supersedes** the workspace-project `schema.ts` "without a Postgres-only
  partial index" comment, whose premise was incorrect. (AS-026, AS-027)
- C-012: update_document returns success only after the new version is durably committed;
  re-anchor runs ASYNC per `annotation-core` C-012 (idempotent by `(annotation_id, version_id)`,
  ledger-based, never mutates an anchor in place); a failed/incomplete re-anchor leaves
  annotations in their PREVIOUS anchored state (never a half-state) and is retried. (AS-028)
- C-013: Every membership/browse check on the MCP read path is parameterized by the token's
  `workspace_id` (a hard cross-tenant invariant — the single-workspace `isWorkspaceMember(userId)`
  leftover must take a workspaceId); a token bound to W1 never surfaces another workspace's
  content. (AS-029)
- C-014: The `Authorization` header is NEVER logged on `/mcp` — because the route is
  envelope-exempt, the centralized redaction is bypassed, so the bearer must be redacted before
  any access/error logging. (GAP-007)

## Linked Fields

- **docId/slug + version** — produced by mcp:S-002 (create/update), matches the identity
  model of `render-publish`/`versioning-diff`. ✔ same doc+version model.
- **anchor + suggestion + status** — produced by `annotation-core` (Data Model: anchor jsonb
  incl. `segments` for multi_range, status fields, suggestion + suggestion_status). Consumed by
  mcp:S-004 (AS-007) and returned to the agent. ✔ pull reads the correct annotation-core model
  (anchor shape now includes `segments?`).
- **`updated_at` + changed-since query** — consumed by mcp:S-004 (AS-008) as the `(updated_at, id)`
  pull watermark. Produced by `annotation-core`:C-017 (updated_at bumped at every mutation site +
  `(updated_at, id)` changed-since query). ✔ now spec'd (resolves GAP-006).
- **re-anchor on new version** — consumed by mcp:S-002 (AS-004/AS-028/C-012) when update_document
  appends a version. Produced by `annotation-core`:S-005 / C-012 (async, idempotent ledger,
  off-publish-path, >25% detached alert). ✔ BUILT + wired (`reanchor-job.ts`, fired from
  `index.ts` on new version) — no longer a gated dependency.
- **user's default project (per workspace)** — produced by `workspace-project`
  (`ensureDefaultProject`/`resolveProjectId` per user per workspace). Consumed by mcp:S-002
  (AS-003) as the container for docs the agent creates when projectId is missing. ✔.
- **project list/read/create** — produced by `workspace-project` (the project model +
  list/create services). Consumed by mcp:S-006 (AS-014/015/017) and used to source a valid
  `projectId` for mcp:S-002 (AS-018). ✔ same project model.
- **settings section registry** — consumed by the mcp-roundtrip Developer section (it mounts
  through `account-settings`'s registry, registering slug + label + content). Produced by
  `account-settings`:S-004 / C-006. ✔ extension contract.

## UI Notes

The only UI is the PAT management surface, mounted as the **Developer** section inside the
`account-settings` shell (it registers through that shell's section registry — it does NOT
own a route of its own). Canonical source for naming + shape: `Anchord-Design/settings-dev.jsx`
(canonical on conflict; AS/Constraints still win). Component names only. Dark-operator (`DESIGN.md`).

- `DeveloperSection` `[N]` *(mounts into account-settings registry at /settings/developer)*
  - `TokenList` → `TokenRow`: name · workspace · scopes · lastUsed · expiry · `RevokeButton`
  - `GenerateTokenButton` → token modal: name + workspace picker + **6 scope checkboxes**
    (`docs:read/write`, `annotations:read/write`, `projects:read/write`)
    *(presets READ-ONLY / PUBLISH / FULL MCP)* + expiry; shows the plaintext `anch_pat_` once (C-008)
  - `McpEndpointInfo` *(the single `/mcp` URL + tool list + a copy-paste setup snippet using
    streamable HTTP + bearer header, no npx — NO workspace picker, the token carries its workspace)*

> Prototype `Anchord-Design/settings-dev.jsx` still (a) labels the scopes `comments:*` —
> relabel `annotations:*` when built, and (b) builds the endpoint as `/mcp/w/<wsPicker>` with a
> workspace picker — simplify to the single `/mcp` URL (token-bound workspace). AS/Constraints
> win over the prototype on both.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| account-settings section registry | apps/web/src/features/settings/ | mount DeveloperSection via the registry (see `account-settings`:S-004) |

### System Impact & Technical Risks

- **SDK spike (S-001, risk):** `@modelcontextprotocol/sdk` is not yet a dependency and there is
  no `src/mcp/`. Its `StreamableHTTPServerTransport` targets Node `req/res`; Elysia/Bun gives
  WHATWG `Request`/`Response`. The adapter (or a hand-rolled JSON-RPC+SSE) is S-001's first
  deliverable — unproven, de-risk before fanning out the tool stories.
- **Envelope exemption is by mount point, not an active guard:** `http/envelope.ts` only
  *comments* that `/mcp` is exempt; the envelope applies wherever `apiEnvelope()` is mounted.
  S-001 MUST mount `/mcp` OUTSIDE any enveloped group (and outside the shared parent whose
  scoped `onAfterHandle` propagates) so responses stay raw JSON-RPC (C-005/AS-023). Also redact
  the bearer in any `/mcp` logging (C-014) — the exempt path bypasses central redaction.
- **Cross-tenant membership leftover:** the existing `isWorkspaceMember(userId)` takes no
  workspaceId (single-workspace leftover). The MCP read path MUST thread the token's
  `workspace_id` into membership/browse checks (C-013), else a W1 token can surface a W2
  `anyone_in_workspace` doc.
- **No workspace-wide accessible-docs query exists:** the web FE assembles the accessible-doc
  set as a per-project union, paginated client-side. `anchord_list_documents` needs a NEW
  workspace-wide server read (AS-006), not a reuse; verify `search/search.ts` returns
  `{items, pagination}` before relying on page+limit.
- **No `resolveProjectAccess`:** projects have no per-owner ACL; v0 MCP project visibility is
  workspace-membership (C-010), matching the existing `listProjects(workspaceId)` browse — do
  NOT invent a per-owner project gate.
- **Project model has no slug:** `read_project` is by id only (AS-017); no `bySlug` lookup exists.
- Cross-spec: create/update = doc+version (`render-publish`/`versioning-diff`); list/read/create
  projects + default project via `workspace-project`; pull/list_comments/reply/resolve use the
  `annotation-core` model; token tied to user (`auth`) and bound to a workspace (`workspaces`);
  PAT UI in `account-settings`. Re-anchor on update is `annotation-core`:S-005 / C-012 — **BUILT
  + wired** (`reanchor-job.ts` fired off-publish-path from `index.ts` on a new version, idempotent
  ledger + >25% alert); S-002's update just needs to fire the existing seam.
  The existing `new-doc-mcp-pane.tsx` shows `/mcp/w/{workspaceId}` — update it to the bare `/mcp`.
- Reuse: no separate content model — MCP is an API surface over existing models + the existing
  per-doc `resolveAccess` (docs only — projects/list/search need their own per-resource gate, C-001).

## Not in Scope

- OAuth 2.1 agent auth + a "Connected Apps" consent UI (better-auth provider) → v0.5 (v0 uses PAT).
- `anchord_upload_asset` / `anchord_upload_zip` / `anchord_publish_with_assets` (rewrite
  img→asset) → v0.5.
- `anchord_list_assets` → ships with the asset tools in v0.5 (listing assets with no MCP path
  to create them is half a feature).
- Project **mutate** via MCP — update/rename/archive/delete/move project, and folders — → v0.5
  (v0 has project list/read/create only).
- set_access / unpublish via MCP → v0.5.
- unorphan / relocate annotation via MCP → v0.5 (v0 done by a person on the UI).
- moderate / delete_document / reactions via MCP → v0.5+.
- n8n integration → v2.
- stdio transport → not doing (in-process streamable HTTP only; no npx CLI package).

## Gaps

- GAP-001 (status: resolved → C-006, AS-003; SUPERSEDED 2026-06-23): originally docs an agent
  creates defaulted to **restricted** (token-owner only; share later by hand/UI; decided 2026-06-07).
  SUPERSEDED by doc-access shared-workspace model: an MCP-created doc now inherits the workspace
  `settings.defaultAccess` (default `anyone_in_workspace`, `workspaces`:C-007) like web/UI publish —
  members see it by default; `restricted` is a per-doc opt-in done on the web UI. Source: doc-access
  audit 2026-06-23.
- GAP-002 (status: resolved → AS-003 + workspace-project:C-009): each account has a
  self-created default project per workspace; MCP places docs there if projectId is missing.
  (Decided 2026-06-07.)
- GAP-003 (status: deferred): reliably *applying* a pulled suggestion agent-side (mapping
  from/to + blockId + offset back onto evolving source) — the pull payload shape is now pinned
  by C-004, but agent-side application is beyond v0. Source: "How is the suggestion payload
  standardized".
- GAP-004 (status: resolved → C-007): per-token rate-limit threshold pinned to 60/min/token
  (tunable) + per-user active-token cap 10; in-memory for v0, durable → v0.5. (Decided 2026-06-19.)
- GAP-005 (status: deferred): the per-doc serialization half is RESOLVED into C-011 (advisory
  lock + UNIQUE backstop). The remaining half — an idempotency KEY (dedupe a create/update retry
  by token+doc, return the original `{docId,slug}` instead of a second insert) — is deferred to
  v0.5; v0 accepts at-least-once (a dropped-response retry can create a duplicate doc, which a
  human deletes). Source: /mf-challenge failure-mode.
- GAP-006 (status: resolved → annotation-core:C-017): AS-008 incremental "changed-since" pull
  needs `annotation-core` `updated_at` (bumped on every mutation incl. re-anchor + reply) +
  a `(updated_at, id)` changed-since query — now spec'd in annotation-core:C-017 (2026-06-19).
  Source: /mf-challenge — model had created_at only.
- GAP-007 (status: deferred): `/mcp` Authorization-header redaction in logging (C-014) is a
  build-time security invariant verified by code review + a logger test, not a system-boundary AS.
  Source: /mf-challenge — envelope-exempt path bypasses central redaction.

## Clarifications — 2026-06-07

- **API token instead of OAuth in v0:** the agent runs local/CI, a header token is the
  simplest self-host approach.
- **Streamable HTTP:** the instance is already a server; a remote/CI agent needs HTTP; stdio is limited.
- **Full round-trip (including reply/resolve):** the "agent edits then marks as handled" loop is what
  truly closes it.
- **create returns slug + update appends version:** matches the identity model locked in
  render-publish/versioning.
- **since-cursor for pull:** so the agent doesn't reprocess already-handled annotations.

## Clarifications — 2026-06-19

- **Endpoint workspace (SUPERSEDED below → bare `/mcp`):** originally `/mcp/w/:workspaceId` to
  mirror `/api/w/:workspaceId/`; reversed later this day once the token became workspace-bound
  (the path workspace was redundant). See the "Endpoint simplified to bare `/mcp`" bullet.
- **Token is workspace-scoped + granular (not account-wide):** modeled on uselink's PAT —
  least-privilege over convenience. One token = one workspace + a scope set; a user with
  multiple workspaces mints one token each (or reuses across endpoints only within its bound
  workspace). Prefix `anch_pat_`, hashed, shown once, optional expiry.
- **Tools prefixed `anchord_*`:** avoids collisions when an agent mounts several MCP servers.
- **In-process streamable HTTP, no npx:** anchord mounts MCP in the backend process, so the
  PAT setup is `claude mcp add --transport http … --header "Authorization: Bearer …"` — no
  `@anchord/mcp` npm package to ship or maintain (better than uselink's stdio CLI).
- **pull payload matches annotation-core reality:** status vocabulary and suggestion shape are
  taken from the built model, not the 2026-06-07 guess.
- **`anchord_list_comments` added; `anchord_list_assets` deferred** to v0.5 with the asset tools.
- **Endpoint simplified to bare `/mcp`** (was `/mcp/w/:workspaceId`): since the token is
  workspace-bound, the path workspace was redundant. The token carries `workspace_id`; the
  server derives the request's workspace from it. This drops the token-vs-path mismatch case
  (former AS-012) and shortens the gate to 3 layers: token valid → scope → per-doc access. Not
  a "server-side current workspace" (the rejected pattern) — `workspace_id` is an immutable
  property of the credential. If v0.5 OAuth introduces account-wide tokens, a `/mcp/w/:id` route
  can be ADDED additively then without breaking PAT configs.
- **Scopes renamed `comments:*` → `annotations:*`:** the entity is the annotation (a comment is
  a child of an annotation's thread; resolve acts on the annotation).
- **Project read+create added (`projects:read`/`projects:write`, S-006):** resolves the latent
  inconsistency that `create_document` took `projectId?` with no MCP way to discover/create a
  project. Project mutate (update/rename/archive/delete/move) + folders stay v0.5.

## Clarifications — 2026-06-19 (/mf-challenge)

- **Token hash = HMAC-SHA256(APP_SECRET) (C-1):** peppered + indexed + constant-time; NOT
  argon2/bcrypt (can't index a per-row salted KDF). Reuse `auth/invite-token.ts`.
- **Project access = workspace-member visibility (C-2):** any workspace member sees all active
  projects (matches the web app); no per-owner project ACL in v0. `read_project` is by id (no slug).
- **Concurrency hardened, GAP-005 split (C-4):** per-doc version serialization + UNIQUE backstops
  land in v0 (C-011); the idempotency-KEY retry-dedup is deferred to v0.5. S-002 → checkpoint.
- **Re-anchor contract referenced (C-5):** update returns after version commit; re-anchor async
  per annotation-core C-012, fail → previous-state + retry. S-002 depends on annotation-core:S-005
  being finalized (currently gated — risk).
- **Cross-tenant membership is a hard invariant (H-2):** every read-path membership check carries
  the token's workspace_id (C-013) — a W1 token never sees W2 content.
- **Cursor keyed `(updated_at, id)` (H-4):** "changed-since" needs annotation-core `updated_at`
  (GAP-006, gates AS-008); anchor payload now includes `segments` for multi_range.
- **Decisions kept against scope-cut findings:** expires_at retained; the 6 granular scopes +
  presets retained (user decision); read_project / list_comments / since-cursor kept (fixed, not cut).

## Clarifications — 2026-06-19 (/mf-build reconciliation)

- **C-011 default-project enforcement = partial-unique index (resolves build-time S2):** during
  `/mf-build` S-002, the partial-unique `UNIQUE(workspace_id, owner_id) WHERE is_default` that
  C-011 mandated conflicted with the `workspace-project` `schema.ts` decision (a plain composite
  index + a comment "without a Postgres-only partial index", justified by the CLAUDE.md
  SQLite-portability rule). Resolution: the partial-unique index **stands** — its premise that
  partial unique indexes are Postgres-only is **factually wrong** (SQLite supports them since
  3.8.0, 2013), so it is portable and does NOT violate the CLAUDE.md rule. The constraint is
  refined to `WHERE is_default AND owner_id IS NOT NULL` (NULL owner_id rows are distinct in a
  unique index; a default project always has an owner). "Exactly one" = the index (at-most-one,
  race-proof) + `ensureDefaultProject` (at-least-one, lazy). **Owed follow-up for S-002:** add the
  partial-unique migration AND remove/correct the stale "no partial index" comment in the
  workspace-project schema. (Decided 2026-06-19, user.)

## Clarifications — 2026-06-23

- **MCP-created docs inherit the workspace `defaultAccess` (shared-workspace model), not hard `restricted`:**
  the 2026-06-07 decision that agent-created docs default to `restricted` is overturned by the
  doc-access audit. An MCP-published doc now inherits its workspace's `settings.defaultAccess`
  (default `anyone_in_workspace`, `workspaces`:C-007) — identical to web/UI publish
  (render-publish:C-011) — so the workspace behaves as a shared group space and members see the
  agent's docs by default. C-006 still holds that visibility is not *settable* via MCP (no
  set_access tool in v0 — stays v0.5); only the inherited DEFAULT changed. AS-003 amended, C-006
  amended, GAP-001 superseded. No new AS (spec at the 30-AS cap; the value is an attribute of the
  existing create AS).

## Spec Sizing Notes

Stories=6 (target 7 — under). AS=30 (target 20 — AT the G7 overage cap ≤30, G1-driven;
highest id AS-031 since removed AS-012 is not reused).

G1 splits / atoms producing the excess AS (each a distinct stated atom from /mf-challenge, not bloat):
- S-001: +AS-022 (revoke mid-session), AS-023 (raw JSON-RPC), AS-024 (rate-limit throttle),
  AS-025 (per-user token cap), AS-030 (absent-Origin allowed — CLI clients), AS-031
  (present non-allowlisted Origin rejected) — distinct auth/transport atoms.
- S-002: +AS-018/019 (projectId honored / foreign rejected), AS-026 (concurrent versions),
  AS-027 (concurrent default project), AS-028 (re-anchor failure) — distinct write-path atoms.
- S-003: +AS-029 (cross-tenant W2 non-leak).

No bloat — each AS traces to one stated atom (a /mf-challenge finding or a prior decision).

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/mcp-roundtrip.md) | -- |
| 2026-06-07 | GAP-001 resolved → C-006 (agent doc = restricted) | -- |
| 2026-06-07 | GAP-002 resolved → AS-003 + workspace-project:C-009 (default project per user) | -- |
| 2026-06-07 | /mf-challenge harden H4: C-008 + AS-010 (token hashed/scope/revoke, pull per-doc authZ); GAP-005 idempotency | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
| 2026-06-19 | Major (snapshot 2026-06-19.md): endpoint `/mcp/w/:workspaceId` + envelope-exempt (C-005); token workspace-scoped + granular scopes (Data Model, C-001/C-008, +C-009); tools renamed `anchord_*`; pull payload matched to annotation-core (C-004/AS-007); +AS-011/AS-012 (scope/workspace rejection), +AS-013 (`anchord_list_comments`); PAT UI = Developer section in account-settings registry (UI Notes + Linked Fields); list_assets → v0.5; GAP-003 narrowed to agent-side apply; S-001 → checkpoint | -- |
| 2026-06-19 | Minor: UI Notes cite prototype `Anchord-Design/settings-dev.jsx` as canonical for the Developer section shape (validates the workspace-scoped + granular-scope token model, create dialog, token list, MCP connection block) | -- |
| 2026-06-19 | Major (snapshot 2026-06-19-2.md): endpoint `/mcp/w/:workspaceId` → bare `/mcp` (token-bound workspace; removed AS-012, gate 4→3 layers, C-001/C-005); scopes renamed `comments:*`→`annotations:*`; +`projects:read/write` (Data Model, C-008/C-009); +S-006 project list/read/create (AS-014/015/016/017); +AS-018/019 (create_document honors/validates projectId, C-006); +C-010 (project tool authz); UI Notes 6-scope modal + bare `/mcp` (no picker) + prototype relabel/simplify note; Not-in-Scope += project mutate/folders | -- |
| 2026-06-19 | Minor: +AS-020 (list tokens never reveals the secret) + AS-021 (revoke action) under S-001 — completes CRD (no U) for api_tokens; C-008 ref extended | -- |
| 2026-06-19 | Minor: GAP-006 resolved → annotation-core:C-017 (updated_at + changed-since now spec'd); de-staled re-anchor notes — annotation-core:S-005/C-012 is BUILT+wired (reanchor-job.ts), not a gated dependency (Linked Fields + System Impact) | annotation-core:C-017 |
| 2026-06-19 | Major (snapshot 2026-06-19-3.md): /mf-challenge findings folded in — token hash = HMAC-SHA256(APP_SECRET) (Data Model/C-008); project access relaxed to workspace-member (C-010/AS-014/017/019); SDK spike (S-001); concurrency C-011 + GAP-005 split (S-002→checkpoint, +AS-026/027); re-anchor contract C-012 (+AS-028); cross-tenant C-013 (+AS-029); origin/envelope C-005 + C-014/GAP-007 (+AS-023); rate-limit C-007 pinned + token cap (GAP-004 resolved, +AS-024/025); revoke-per-request + last_used_at throttle (C-001/008, +AS-022); cursor (updated_at,id) + GAP-006 + anchor segments (AS-008/AS-007/C-004); read_project id-only (AS-017). 6 stories / 28 AS (+Spec Sizing Notes) | -- |
| 2026-06-19 | Major (snapshot 2026-06-19-4.md): C-011 refined — default-project enforcement = partial-unique `UNIQUE(workspace_id, owner_id) WHERE is_default AND owner_id IS NOT NULL` (resolves build-time S2 with workspace-project's "no partial index" comment; partial unique IS portable per SQLite 3.8+); + Clarification (/mf-build reconciliation). S-002 owes the migration + a workspace-project comment fix | -- |
| 2026-06-19 | Major (snapshot 2026-06-19-5.md): C-005 Origin reworded — validate ONLY WHEN PRESENT (present non-allowlisted → reject DNS-rebinding; absent/missing → ALLOWED so CLI MCP clients connect), transport = SDK web-standard Streamable HTTP MCP (initialize/tools.list/tools.call); AS-001 Then expanded for the handshake (resolves S1); +AS-030 (absent-Origin allowed) +AS-031 (present non-allowlisted Origin rejected). 30 AS (at cap). | -- |
| 2026-06-20 | Major (snapshot 2026-06-20.md): pull_annotations gains OPTIONAL filter params (status unresolved/resolved; includeOrphaned/Dismissed/Deleted default-true; type) — the model picks filters from the user's request at call time; default (no filter) unchanged = all + flags (preserves AS-008 incremental fidelity); filters narrow server-side + compose with cursor (agent owns the trade-off). Folded into C-004 + AS-007 (no new AS — at 30-cap). | -- |
| 2026-06-23 | Major (M5+M6, snapshot 2026-06-23-default-access.md) — doc-access shared-workspace model: AS-003 Then + C-006 amended so an MCP-created doc INHERITS the workspace `settings.defaultAccess` (default `anyone_in_workspace`, `workspaces`:C-007) instead of hard `restricted`; GAP-001 superseded; +Clarifications-2026-06-23. Covers the MCP-publish surface of sharing-permissions:C-018 (web/UI surface → render-publish:AS-027). No new AS (at 30-cap; value is an attribute of the existing create AS-003). Snapshot limit set to 8 (matches the 6 prior). | doc-access audit 2026-06-23 |
