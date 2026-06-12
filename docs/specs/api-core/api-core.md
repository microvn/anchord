# Spec: api-core

**Created:** 2026-06-08
**Last updated:** 2026-06-12
**Status:** Draft

## Overview

The cross-cutting HTTP contract every anchord `/api/*` route follows: one response
envelope, one error-code→status mapping, boundary request validation, a session auth
gate, and a pagination shape. It does not add features — it formalizes the wire
conventions for the already-built cluster service logic so routes can be mounted
consistently (and an Eden Treaty client can type against them). Per-endpoint lists live
in each cluster spec's own `## API` section; this spec owns only the shared rules.

> **Impl-vocab note:** every other spec bans HTTP status codes in acceptance scenarios
> (they assume a "how" the spec hasn't committed to). api-core is the one spec whose
> *subject* is the wire protocol, so status codes (200/400/401/403/404/409/413/429/500)
> are first-class domain values here, not banned impl-vocab.

## Data Model

No persistent entities. It defines two response shapes (the contract every route emits):

- **Success envelope:** `{ success: true, data: <T>, timestamp, path, statusCode, requestId }`.
- **Error envelope:** `{ success: false, error: { code, message, details?, field? }, timestamp, path, statusCode, requestId }`.
- **Pagination block** (inside `data` on list endpoints): `{ items: <T[]>, pagination: { page, limit, total, totalPages, hasNext, hasPrevious } }`.
- **Error code** is a stable string enum (e.g. `VALIDATION_ERROR`, `UNAUTHENTICATED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `INTERNAL`).

## Stories

### S-001: Every response uses the unified envelope (P0)

**Description:** As an API client (the web app via Eden, or an integrator), I get every
anchord `/api/*` response in one predictable shape — success or failure — so I can parse
it the same way everywhere.
**Source:** description items (1) unified response envelope, (7) /api prefix ownership.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (expected `src/http/envelope.*`, `src/http/request-id.*`, `src/app.ts`)
- `autonomous:` true
- `verify:` hit a mounted `/api/*` route → body has `success`, `data`, `timestamp`, `path`, `requestId`; trigger an error → body has `success:false` + `error.code`.

**Acceptance Scenarios:**

AS-001: A successful handler result is wrapped in the success envelope
- **Given:** a mounted `/api/*` route whose handler returns a plain value
- **When:** a client calls it successfully
- **Then:** the body is `{ success: true, data: <the value>, timestamp, path, statusCode: 200, requestId }`; the handler does not hand-wrap its own envelope
- **Data:** a route returning a single object

AS-002: A failed request is wrapped in the error envelope
- **Given:** a route whose handler raises a domain error
- **When:** a client calls it
- **Then:** the body is `{ success: false, error: { code, message }, timestamp, path, statusCode, requestId }`; no raw framework error shape leaks
- **Data:** a handler that rejects with a NOT_FOUND domain error

AS-003: requestId is echoed when supplied, generated otherwise
- **Given:** the contract requires a correlation id on every response
- **When:** a client sends an `x-request-id` header / when it sends none
- **Then:** the supplied id is echoed in `requestId`; when absent, a fresh id is generated and returned
- **Data:** one request with `x-request-id: req_abc`, one with none

### S-002: Domain errors surface the correct HTTP status (P0)

**Description:** As an API client, a failure tells me what went wrong via a stable
`error.code` AND the matching HTTP status, so both humans and code can branch on it.
**Source:** description item (2) error-code→status mapping.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (expected `src/http/errors.*` — error classes + status map)
- `autonomous:` true
- `verify:` raise each domain error kind → response carries the mapped status + code.

**Acceptance Scenarios:**

AS-004: A validation failure surfaces as 400
- **Given:** a request that fails input validation
- **When:** it is processed
- **Then:** status 400, `error.code = VALIDATION_ERROR`, with field-level `details`
- **Data:** a body missing a required field

AS-005: A conflict surfaces as 409
- **Given:** an operation that violates a uniqueness/state rule (e.g. a duplicate slug)
- **When:** it is attempted
- **Then:** status 409, `error.code = CONFLICT`
- **Data:** publishing two docs that resolve to the same slug

AS-006: An unexpected error surfaces as 500 without leaking internals
- **Given:** a handler throws an unmapped/unexpected error
- **When:** it is processed
- **Then:** status 500, `error.code = INTERNAL`, a generic message; NO stack trace, SQL, or internal path in the body
- **Data:** a handler that throws a raw error

### S-003: Protected routes require a valid session (P0)

**Description:** As the system, I only run a protected handler for an authenticated
caller, and I resolve who they are and what role they hold from the session on the
server — never from anything the client sends.
**Source:** description item (5) auth gate + server-resolved identity; consumed by annotation-core C-009.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (expected `src/http/auth-gate.*` reusing better-auth session)
- `autonomous:` true
- `verify:` call a protected route with no cookie → 401; with a valid session cookie → handler runs with the server-resolved user.

**Acceptance Scenarios:**

AS-007: A protected route with no/invalid session is rejected
- **Given:** a route marked protected
- **When:** it is called with no session cookie, or an expired/invalid one
- **Then:** status 401, `error.code = UNAUTHENTICATED`; the handler is never reached
- **Data:** a request with no cookie, and one with a garbage cookie

AS-008: Identity and role come from the session, not the client
- **Given:** a valid session for a commenter-role user
- **When:** the request body/headers ALSO carry a forged `role: owner` / `userId` field
- **Then:** the handler acts on the SERVER-resolved identity (commenter); the client-supplied role/identity is ignored
- **Data:** a valid commenter session + a spoofed `role: "owner"` in the body

AS-009: An authenticated caller lacking the capability is forbidden
- **Given:** an authenticated caller who can see a resource but lacks the capability for the action
- **When:** they attempt the action
- **Then:** status 403, `error.code = FORBIDDEN`
- **Data:** a viewer-role session calling a create-comment route

### S-004: Access denial is indistinguishable from non-existence (P0)

**Description:** As the system, when a caller has no access to a doc, I respond exactly as
if it did not exist, so no one can probe which docs are real.
**Source:** description item (3) existence-hiding; consumes sharing-permissions C-003 + annotation-core C-010.

**Execution:**
- `depends_on:` S-001, S-003
- `parallel_safe:` false
- `files:` unknown (expected `src/http/access-result.*` mapping canViewDoc → response)
- `autonomous:` true
- `verify:` request an existing-but-restricted doc as an outsider, and a truly-missing doc → byte-identical 404 responses.

**Acceptance Scenarios:**

AS-010: A no-access doc returns the same 404 as a missing doc
- **Given:** doc A exists but the caller is not authorized, and doc B does not exist
- **When:** the caller requests each
- **Then:** both return status 404 with the SAME `error.code = NOT_FOUND` and the same body shape; nothing distinguishes "exists but forbidden" from "does not exist"
- **Data:** an existing restricted doc + a random non-existent id

AS-011: No content of a no-access doc leaks in the denial
- **Given:** an existing restricted doc the caller cannot access
- **When:** the caller requests it
- **Then:** the 404 body carries no title, content, owner, or any field of the real doc
- **Data:** a restricted doc with a known title

### S-005: Requests are validated at the boundary (P0)

**Description:** As the system, I validate and shape every request body/query with a
schema before any service logic runs, so bad input is rejected uniformly and unknown
fields never reach a service.
**Source:** description item (4) Zod boundary validation.

**Execution:**
- `depends_on:` S-001, S-002
- `parallel_safe:` false
- `files:` unknown (expected `src/http/validate.*` Zod adapter)
- `autonomous:` true

**Acceptance Scenarios:**

AS-012: Invalid input is rejected before the service runs
- **Given:** a route with a request schema
- **When:** a request arrives with a missing/invalid field
- **Then:** status 400, `error.code = VALIDATION_ERROR`, `details` naming the bad field(s); the underlying service is never invoked
- **Data:** a create request with a wrong-typed field

AS-013: Unknown fields are stripped, not forwarded
- **Given:** a route with a request schema
- **When:** a request carries extra fields not in the schema
- **Then:** the unknown fields are removed; the service receives only the schema-defined fields
- **Data:** a valid body plus an extra `isAdmin: true` field

### S-006: List endpoints return a uniform pagination shape (P1)

**Description:** As an API client, every list endpoint takes the same paging params and
returns the same pagination metadata, so I render pagers the same way everywhere.
**Source:** description item (6) pagination.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (expected `src/http/pagination.*`)
- `autonomous:` true

**Acceptance Scenarios:**

AS-014: A list endpoint returns items plus pagination metadata
- **Given:** a list endpoint with more rows than one page
- **When:** a client requests page 1 with a limit
- **Then:** `data = { items, pagination: { page, limit, total, totalPages, hasNext, hasPrevious } }` with correct values
- **Data:** 25 rows, limit 10 → page 1: 10 items, total 25, totalPages 3, hasNext true, hasPrevious false

AS-015: Out-of-range paging params are bounded
- **Given:** the limit has a maximum and page is 1-based
- **When:** a client requests a limit above the max, or a page below 1
- **Then:** the limit is clamped to the max; a page below 1 is rejected with status 400, `error.code = VALIDATION_ERROR`
- **Data:** limit 1000 (max 100) → clamped to 100; page 0 → 400

## Constraints & Invariants

- C-001: Every `/api/*` response — success or error — is emitted through the unified
  envelope; handlers return raw data and never hand-wrap. (AS-001, AS-002)
- C-002: Every response carries a `requestId`: echoed from `x-request-id` if present, else
  generated. (AS-003)
- C-003: Domain errors map to a fixed code→status table: VALIDATION_ERROR→400,
  UNAUTHENTICATED→401, FORBIDDEN→403, NOT_FOUND→404, CONFLICT→409,
  PAYLOAD_TOO_LARGE→413, RATE_LIMITED→429, INTERNAL→500. (AS-004, AS-005, AS-006, AS-007, AS-009, AS-010)
- C-004: A 500/INTERNAL response never leaks internals (stack trace, SQL, file paths,
  dependency errors) in the body. (AS-006)
- C-005: A protected route never runs its handler without a valid better-auth session;
  the caller's identity AND role are resolved server-side from the session, never trusted
  from client input. (AS-007, AS-008)
- C-006: A read denied by doc access returns a response byte-identical to a non-existent
  doc (404/NOT_FOUND), leaking no existence signal or content; this overrides the generic
  403 path for resource *reads*. (AS-010, AS-011)
- C-007: Request bodies/queries are validated against a schema at the boundary before the
  service runs; invalid → 400 with field details, unknown fields stripped. (AS-012, AS-013)
- C-008: List endpoints share the pagination contract: accept `page` (1-based) + `limit`
  (capped) + `sort`, return the `{ items, pagination }` block; limit over max is clamped,
  page < 1 is rejected. (AS-014, AS-015)
- C-009: The envelope/validation/error conventions apply to anchord's OWN `/api/*` routes.
  `/api/auth/*` (better-auth) and `/mcp` (MCP Streamable HTTP, JSON-RPC) keep their own
  native protocols and are explicitly exempt. (AS-001)

## What Already Exists

### System Impact & Technical Risks

- `src/app.ts` (Elysia) currently mounts only `/health`, `/d/:slug`, `/v/:id`
  (render-publish viewer). All cluster service logic (auth, sharing, annotation, publish,
  versioning) is built + unit-tested but UNMOUNTED — this contract is what mounting
  follows. The render-publish viewer routes (`/d`, `/v`) serve HTML/raw content, not the
  JSON envelope, and stay as-is (they are not `/api/*` JSON routes).
- Reuse: `src/sharing/access.ts` `canViewDoc` + `src/sharing/roles.ts` `can`/`effectiveRole`
  back C-005/C-006; better-auth (`src/auth/auth.ts`) provides the session for the auth gate;
  Zod (already a dep, used in `src/config/env.ts`) backs C-007.
- Risk: C-006 existence-hiding is a security invariant that must be enforced in the shared
  layer, not per-route — a single route that 403s instead of 404s on a no-access read
  reintroduces the existence leak. The shared access→response mapper is the single
  enforcement point.

## Not in Scope

- Per-cluster endpoint lists (paths, bodies per route) — live in each cluster spec's
  `## API` section, added separately.
- GraphQL / tRPC — REST + Eden Treaty only in v0.
- API versioning (`/api/v2`) — v0 is a single unversioned surface.
- Public API keys / external developer API — MCP agents use `api_tokens` (mcp-roundtrip),
  a separate auth path from the session cookie gate here.
- Rate-limit *policy* (thresholds, windows) — owned by auth (sign-in) + sharing (link
  password); api-core only fixes RATE_LIMITED→429 in the mapping.

## Clarifications — 2026-06-08

- **Status codes are domain vocabulary here (not banned impl-vocab):** api-core's subject
  IS the wire protocol, so the AS commit to concrete statuses. Feature specs still avoid
  them; they map their behaviors onto this contract via their `## API` sections.
- **Envelope applies to `/api/*` only:** better-auth `/api/auth/*` and `/mcp` keep their
  own protocols (C-009) — wrapping them would break their clients.
- **Existence-hiding beats generic forbidden for reads (C-006):** a no-access *read* is
  404, not 403, so it is indistinguishable from a missing doc. A 403 is reserved for an
  action a *visible* resource's role can't perform (AS-009). This split is deliberate.
- **Pagination out-of-range = clamp limit, reject page<1:** limit over max clamps (lenient,
  avoids breaking a client asking for "all"); page<1 is a client bug → 400.

## Clarifications — 2026-06-12

- **The envelope `onError` maps the FRAMEWORK's built-in errors too, not only our domain errors
  (refines S-002 / AS-006).** Elysia's own `NOT_FOUND` (an UNMATCHED route) → 404 `NOT_FOUND`;
  Elysia `VALIDATION`/`PARSE` → 400 `VALIDATION_ERROR`. Without this, a route mismatch fell through to
  `INTERNAL 500`, masking a 404 as a server crash (this is exactly how an FE/BE comment-path mismatch
  surfaced as an opaque 500). Only a genuinely unexpected error is `INTERNAL 500`.
- **An unexpected 500 is LOGGED server-side (refines AS-006).** AS-006 still holds — NO stack/SQL/path
  in the response BODY — but the `INTERNAL` branch now `console.error`s the real error + the `requestId`
  to stderr, so a 500 is never silent (a silent 500 with no trace is an ops blackhole). Client-facing
  shape is unchanged.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-08 | Initial creation (cross-cutting HTTP contract; closes the no-API-section gap across specs) | -- |
| 2026-06-12 | Minor (Clarifications): envelope onError maps Elysia built-in errors (unmatched route NOT_FOUND→404, VALIDATION/PARSE→400), not just domain errors; unexpected 500s are logged server-side (stack + requestId) with the client body still leaking nothing (refines S-002/AS-006) | commit `9fac99b` |
