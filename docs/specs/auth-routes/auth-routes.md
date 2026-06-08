# Spec: auth-routes

**Created:** 2026-06-08
**Last updated:** 2026-06-08
**Status:** Draft

## Overview

Wire the live better-auth session into the mounted `/api` routes and record **doc
ownership**, closing the two seams the route-mounting left open: docs had no owner
(so managing a doc's sharing stayed closed for everyone) and route writes recorded no real
user (published_by/author_id were null/placeholder). After this slice, a signed-in
publisher owns the doc they create, the owner holds the top role on every access
decision, and every authenticated write records the real session user.

## Data Model

- **docs.owner_id** (NEW): the user who owns the doc = the authenticated user who first
  published it. References `user.id` (a **text** id from better-auth, NOT uuid). Nullable
  (a doc seeded/published without a session has no owner).
- **doc_versions.published_by** (EXISTING, type change): currently `uuid` with no FK and
  written null. Becomes **text** referencing `user.id`, recording the authenticated
  publisher of each version. (Root fix for the uuid-vs-better-auth-id mismatch.)
- **comments.author_id** (EXISTING): already `text` → `user.id`; this slice ensures the
  route actually populates it from the session for a signed-in comment.
- Roles unchanged: `share_role` (viewer|commenter|editor); **owner** is a model-level role
  (sharing-permissions `roles.ts`) conferred by `docs.owner_id`, never a stored share row.

## Stories

### S-001: Publishing while signed in records ownership (P0)

**Description:** As a signed-in member, when I publish a doc, I am recorded as its owner so
I (and only I) can manage its sharing later.
**Source:** route-mounting gap #1 (doc ownership not stored); sharing-permissions C-007 (owner manages sharing).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (`src/db/schema.ts` + migration, `src/routes/docs.ts`, `src/publish/*`)
- `autonomous:` checkpoint
- `verify:` publish a doc as user A (real session) → the doc's owner is A; publish without a session → refused.

**Acceptance Scenarios:**

AS-001: A signed-in publish records the publisher as owner
- **Given:** user A is signed in (valid session)
- **When:** A publishes a new doc
- **Then:** the doc is created with A recorded as its owner; version 1 records A as its publisher
- **Data:** A publishes one HTML doc

AS-002: Publishing without a session is refused
- **Given:** no session is presented
- **When:** a publish is attempted
- **Then:** it is refused as unauthenticated; no doc and no owner are created
- **Data:** request with no session cookie

### S-002: The doc owner holds the owner role on every access decision (P0)

**Description:** As the owner of a doc, my effective role on it is owner (the highest), so
owner-exclusive actions (managing sharing, toggling whether editors can share) resolve correctly
for me. (Who *else* may manage sharing — permitted editors — is sharing-permissions C-007's rule,
which this slice only enables by supplying the real owner.)
**Source:** route-mounting gap #1 (resolveDocRole owner source); sharing-permissions C-002 (highest role wins), C-007 (Google-Docs manage-sharing model).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`src/sharing/resolve-doc-role-repo.ts`, `src/index.ts`, `src/routes/sharing.ts`)
- `autonomous:` true
- `verify:` owner opens the Share box → allowed; a viewer opens it → denied; owner with a lesser invited role still resolves to owner.

**Acceptance Scenarios:**

AS-003: The owner can manage sharing
- **Given:** user A owns a doc
- **When:** A changes the doc's general access
- **Then:** the change is allowed and saved
- **Data:** A sets the doc to anyone-with-link

AS-004: A viewer cannot manage sharing
- **Given:** user B has the viewer role on A's doc, B is not the owner
- **When:** B tries to change the doc's general access
- **Then:** the request is refused (viewers never manage sharing; the owner+permitted-editor rule is sharing-permissions C-007)
- **Data:** B is a viewer

AS-005: Owner role wins over a lesser stored role
- **Given:** user A owns the doc AND also appears as an invited commenter on it
- **When:** A's effective role on the doc is resolved
- **Then:** A's role is owner (the highest), not commenter
- **Data:** A is both owner and an invited commenter

### S-003: Authenticated writes record the real session user (P0)

**Description:** As a signed-in user, when I create a version or post a comment, the system
records me as the publisher/author from my session, never from anything I send in the body.
**Source:** route-mounting gap #2 (writes recorded null/placeholder user).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`src/routes/versions.ts`, `src/routes/annotations.ts`)
- `autonomous:` true

**Acceptance Scenarios:**

AS-006: A signed-in version create records the publisher
- **Given:** user A is signed in and may edit a doc
- **When:** A submits new content
- **Then:** the new version records A as its publisher
- **Data:** A appends a version

AS-007: A signed-in reply records the author
- **Given:** user A is signed in and may comment
- **When:** A replies in a thread
- **Then:** the comment records A as its author (no guest name)
- **Data:** A posts a reply

AS-008: A guest reply records no account author
- **Given:** an anonymous guest (no session) on a guest-commenting doc
- **When:** the guest posts a comment with a name
- **Then:** the comment records the guest name and no account author
- **Data:** guest "Lan", no session

### S-004: The live session cookie resolves the actor for /api routes (P0)

**Description:** As the system, I resolve who is calling an `/api` route from the live
better-auth session cookie on the server, so identity and role are never taken from the
request body.
**Source:** route-mounting gap #2 (interim fake resolver); api-core C-005 (server-resolved identity).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (`src/index.ts`, `src/http/auth-gate.ts`, `test/integration/*`)
- `autonomous:` true
- `verify:` sign up + sign in over HTTP to get a real cookie → call an /api route → the handler acts as that user; drop the cookie → refused.

**Acceptance Scenarios:**

AS-009: A valid session cookie resolves the calling user
- **Given:** a user signed in over HTTP holds a valid session cookie
- **When:** they call a protected `/api` route with that cookie
- **Then:** the handler runs as that user (their identity resolved from the session)
- **Data:** a real signed-in session

AS-010: A missing or invalid session cookie is refused
- **Given:** no session cookie, or a tampered/expired one
- **When:** a protected `/api` route is called
- **Then:** it is refused as unauthenticated; the handler does not run
- **Data:** request with a garbage cookie

## Constraints & Invariants

- C-001: A doc records its owner = the authenticated user who first published it; in v0 the
  owner is immutable (transfer is deferred to sharing-permissions v0.5). (AS-001)
- C-002: Publishing requires an authenticated session; a no-session publish creates nothing. (AS-002)
- C-003: The doc owner's effective role on the doc is owner — the highest in precedence —
  and overrides any lesser stored role for that user. (AS-003, AS-005)
- C-004: A viewer/commenter can never manage a doc's sharing. (The full manage-sharing model —
  owner always + editor when `editors_can_share` — is sharing-permissions C-007; this slice
  supplies the real owner that rule depends on.) (AS-004)
- C-005: An authenticated version/comment write records the actor from the session
  (publisher/author); a guest comment records the guest name and no account author; the
  recorded identity is never taken from the request body. (AS-006, AS-007, AS-008)
- C-006: `/api` routes resolve the actor (identity + role) from the live better-auth session
  cookie server-side; no/invalid session → unauthenticated, handler not reached. (AS-009, AS-010)
- C-007: User identity is a text id (better-auth); `docs.owner_id` and
  `doc_versions.published_by` reference `user.id` as text (not uuid). (AS-001, AS-006)

## Linked Fields

- `owner_id` — produced by auth-routes:S-001 (AS-001) on the doc at publish (persisted, served
  on every access check). Consumed by `sharing-permissions` role resolution + S-002 (AS-003/004)
  to grant the owner role. ✔ persisted at create, read on every sharing decision.
- `published_by` — produced by auth-routes:S-003 (AS-006) on each version (persisted). Consumed
  by `versioning-diff` history (publisher column) + re-anchor publisher. ✔ persisted + served on history.

## What Already Exists

### System Impact & Technical Risks

- The `/api` routes (`src/routes/*.ts`), the api-core HTTP layer (`src/http/*`), and the
  sharing role resolution (`src/sharing/resolve-doc-role-repo.ts` `createResolveDocRole`)
  are built. `createResolveDocRole` already resolves invited + link roles and takes an
  `isOwner(docId, userId)` sub-port that is currently wired to `async () => false` (the seam
  this slice closes). `src/index.ts` wires the real `db` + `betterAuthSessionResolver(auth)`.
- `src/publish/service.ts` `publishDoc` + `src/publish/repo.ts` `createDocRepo` create the
  doc + version 1 — they must record `owner_id` + `published_by` from the actor. `publishDoc`
  takes no actor today; thread the session userId through the route → service → repo.
- `doc_versions.published_by` is `uuid` with no FK and written null; this slice changes it to
  `text` + FK and populates it. `comments.author_id` is already `text`→`user.id`; the route
  must populate it from the session.
- Risk (sensitive): this is the auth/identity boundary + a schema migration (owner_id added,
  published_by retyped). The migration runs on an all-null `published_by` (no real users yet),
  so the type change is safe, but S-001 is `checkpoint`.

## Not in Scope

- Transfer ownership / co-owners — sharing-permissions v0.5 (the column makes it possible later).
- Workspace-member-derived roles (anyone_in_workspace) — needs `workspace-project` (not built);
  `isWorkspaceMember` stays a separate seam.
- MCP-token-published docs recording ownership — `mcp-roundtrip` (not built); MCP publish ties
  a doc to the token's user there.
- Backfilling owners for any pre-existing ownerless docs — none exist (greenfield); no backfill.

## Gaps

- GAP-001 (status: deferred): a doc published with no session has `owner_id = null` → no one can
  manage its sharing. In v0 publish REQUIRES a session (C-002), so this is unreachable for the
  app path; only a directly-seeded row could be ownerless. Deferred — owner: revisit if MCP/seed
  paths create ownerless docs. Source: "a doc seeded/published without a session has no owner".

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-08 | Initial creation (close route-mounting gaps #1 owner / #2 real-user writes) | -- |
