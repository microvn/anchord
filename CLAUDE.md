# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status: greenfield

The repo is empty except for git. **No code is scaffolded yet** — there is no
`package.json`, no `src/`, no Docker setup. Do not assume any command below
already works; they describe the *intended* setup once the skeleton lands.

The source of truth for product scope and decisions is the design doc:
`~/.gstack/projects/claude/administrator-design-20260607-self-hosted-annotation.md`.

## What anchord is

Self-hosted, own-your-data platform to share and **annotate AI-generated docs**
(HTML/Markdown specs, plans, reports from Claude/Cursor/Codex). Author publishes
an artifact as a link; reviewers open it, read the rendered doc, and leave
comments/highlights/suggestions in a right-hand margin. An agent pulls feedback
back via MCP to revise. Everything runs on your own infra — data never leaves
the box.

Positioning: "Vaultwarden for AI-generated docs." The differentiator is
**own-your-data + free collaboration**, not "prettier than uselink." Do not
trade that away. License is **AGPL-3.0**.

## Architecture decisions (locked)

**Backend stack** (chosen after research — see "Why" below):

| Layer | Choice |
|---|---|
| Runtime | Bun |
| Web framework | ElysiaJS |
| Database | PostgreSQL (primary, v0 only — do **not** add a second DB) |
| ORM + migrations | Drizzle ORM + drizzle-kit |
| Postgres driver | postgres.js (not `Bun.sql`, to keep Node portability) |
| Validation | Zod (input, share-link payloads, MCP tool args) |
| HTML sanitize | isomorphic-dompurify (rendering AI HTML is the main XSS surface) |
| Version diff | @pierre/diffs |
| MCP server | @modelcontextprotocol/sdk, same process as the backend |

**Frontend**: React 19 + Vite + Tailwind 4 — chosen specifically to reuse
Plannotator's OSS annotation editor (`@plannotator/review-editor` +
`@plannotator/ui`, MIT/Apache → compatible with AGPL, keep the NOTICE). The hard
part (select text → margin comment → anchor) is worth reusing.

**Self-host packaging**: v0 = `docker compose up` (app + Postgres + named
volume). v1 may ship the app as a `bun --compile` binary pointing at an external
Postgres. No telemetry, no phone-home, ever.

### Why Postgres over SQLite (don't relitigate)
anchord's core workload is **multiple people commenting on one doc** — a
multi-writer pattern. SQLite serializes all writes (whole-file lock); Postgres
MVCC handles concurrent writers. Postgres is also the de-facto self-host norm
(Cal.com, Plausible, Outline all ship compose-with-Postgres), so it costs
nothing on the "easy self-host" positioning. Drizzle keeps the schema portable,
so a SQLite "lite" single-binary build stays *possible* later — but support one
DB at a time to avoid doubling the test surface.

### Why Bun + Elysia over Node + NestJS (don't relitigate)
Bun: native TS, fast cold start, and the `bun --compile` single-binary path is a
strategic asset for self-host. Elysia is Bun-native, fastest in class, with
end-to-end type safety (Eden). NestJS solves the large-team/many-module problem
anchord (solo, async-annotation scope) does not have, at the cost of DI/decorator
weight that fights the lightweight self-host goal.

## Core domain model

Three-tier hierarchy: **Workspace** (tenant: members, settings, auth) →
**Project** (group of related docs) → **Doc** (artifact). A Doc has immutable
**Versions** (each publish appends one). An **Annotation** anchors to a Version
and carries a thread of **Comments**.

- **Anchor type 1 — text range**: must survive across versions via content-hash
  (read how Plannotator solves this *before* designing your own).
- **Anchor type 2 — image region**: point/box in normalized coordinates.
- **Roles** (per-doc, Google-Docs style): viewer / commenter / editor / owner.
- **General access**: restricted / anyone-with-link / anyone-in-workspace. **Default =
  `anyone_in_workspace` (shared-workspace model, locked 2026-06-23): workspace = shared group space.** A new
  doc inherits its workspace's `settings.defaultAccess` (default `anyone_in_workspace`) at publish —
  web AND MCP — so workspace members see new docs by default; `restricted` is a per-doc opt-in for a
  private doc. The `defaultAccess` setting was declared but unwired before this; an admin UI to change
  it per workspace is deferred (v0.5+). Do not relitigate back to restricted-by-default. Specs:
  `workspaces`:C-007, `sharing-permissions`:C-018, `render-publish`:C-011/AS-027, `mcp-roundtrip`:AS-003/C-006.
  Guest
  commenting has NO separate toggle (Google-Docs model, REVERSED 2026-06-20): an
  anyone-with-link doc whose link role is commenter+ lets anyone with the link —
  including no-account guests (name + optional email) — comment; the link role IS the
  grant. (The old "guest commenting is a sub-toggle of anyone-with-link" is retired —
  it was redundant with role and broke the common case by default. Do not relitigate.)
- Auth (how you log in) is separate from roles/share (what you can do after).
  v0 auth: email+password, magic link, GitHub OAuth. OIDC/SAML SSO is the
  self-host advantage but lands v0.5+ — verify library support before committing.

## v0 scope discipline

In: async annotation (read → comment → author reviews later), versioning + diff,
sharing/roles, **multi-workspace** (each account owns a "default" workspace; create
more, invite/remove members, switch — see `docs/specs/workspaces/`), basic search,
reply notifications, MCP publish + pull-annotations, `docker compose up`.

> **Workspace model — REVERSED 2026-06-09.** v0 was originally "single workspace =
> instance"; the product owner changed it to **multi-workspace with full UI**. Each
> account auto-creates its own "default" workspace (creator = owner) on sign-up, can
> create more, invite members by email (accept/reject), remove/change-role, and switch.
> Tenancy is scoped by URL path `/api/w/:workspaceId/…` (not a server-side current
> workspace); custom `workspaces`/`workspace_members` tables (NOT the better-auth org
> plugin); per-doc sharing stays orthogonal to membership (most-permissive wins). The
> earlier single-workspace `POST /api/setup` first-run is removed (auto-create-on-signup).
> Do not relitigate back to single-workspace. Spec: `docs/specs/workspaces/workspaces.md`.

**Out of v0 (explicitly deferred):** real-time multi-editor collaboration
(CRDT/OT) — it sinks solo OSS projects, costs 2-3 months alone, and async covers
~90% of the value. Also deferred: PDF/live-URL annotation, visual no-code editor,
editor integrations. See design doc §4 for the full versioned feature table.

## Conventions

- Bun loads `.env` automatically — do not add `dotenv`.
- drizzle-kit owns schema/migrations; apply at boot with the runtime migrator
  (`drizzle-orm/postgres-js/migrator`), which is a runtime dep, so production
  images don't need drizzle-kit (a dev dep).
- Any AI-generated HTML must pass through dompurify before render or storage.
- Keep the Drizzle schema portable: avoid Postgres-only features that would
  close the door on a future SQLite build.

## Frontend folder architecture (MANDATORY — `apps/web`)

Spec: `docs/specs/web-structure/`. Adapted from feature-based principles for anchord's
real stack (Vite + React Router + Eden treaty + better-auth + React Query). When adding
or moving FE code, follow this exactly — do not regress to flat features or relative imports.

- **Feature-based.** Code lives under `src/features/<feature>/`, organized by feature, NOT
  by technical layer. Each feature owns its `services/client.ts` (typed Eden request thunks —
  the service layer) and `types/` (shared types). Single-use prop types stay co-located in
  their component file; only types used by 2+ files go in `types/`.
- **Every feature is fully sub-layered — the feature root holds only subdirectories, no loose
  files.** The subfolders (each created only when it has content — no empty folders):
  `components/` (UI `.tsx`), `hooks/` (`use-*.ts`), `services/` (the Eden API client —
  `services/client.ts`), `types/` (feature TS types), `schema/` (Zod form schemas), `lib/`
  (feature-local helpers), `tests/` (cross-cutting feature tests). Single-subject tests live
  next to their subject (in `components/`/`lib/`); flow-spanning tests go in `tests/`. No
  per-feature `index.ts` barrel — imports stay explicit `@/features/<f>/<sub>/<file>`.
  (Uniform across all features — decided 2026-06-13.)
- **Cross-module imports use the `@/` alias** (`@/lib/api`, `@/features/docs/services/client`),
  never deep relative paths (`../../lib/api`). Same-directory siblings stay relative (`./x`).
- **One home per layer.** App shell / providers / guards → `src/app/`. API infra (`api`,
  `api-error`, `auth-client`, `use-api-query`) → `src/lib/api/`. Pure utils → `src/lib/` root.
  Global hooks → `src/hooks/`. Shared primitives → `src/components/` (`ui/` for radix wrappers).
- **Tests live with their feature** under `src/features/<feature>/`: a single-subject test
  next to its subject (`components/`/`lib/`), a cross-cutting/flow test in `<feature>/tests/`.
  Only app-root / shared-primitive / infra tests and `test/setup.ts` stay in `test/`.
  Any file move MUST update every importer AND `mock.module(...)` target in the same change.
- **Locked rejections** (don't reintroduce from borrowed guides): no Zustand global store
  (React Query owns server state, `useState` owns local); no axios (Eden treaty only); no
  PascalCase filenames (kebab-case everywhere); keep `import type { App } from "backend"`
  a type-only import — never alias it into backend source.

Conventions doc for contributors: `apps/web/FRONTEND.md`.

## Design System
Always read DESIGN.md before any visual or UI decision. Font choices, colors,
spacing, and aesthetic direction live there. Do not deviate without explicit user
approval. In QA/review, flag any UI that doesn't match DESIGN.md.

Core principle: chrome recedes behind content — doc + comments are the only
high-contrast elements; the user's rendered doc (in the sandbox iframe) keeps its
OWN style and is never styled by this design system. Accent is a single deep teal
(dark #37b3bd / light #0b6b73); never purple, never Claude-orange #d97757.

Responsive is mandatory on every screen (not desktop-only). See DESIGN.md §Responsive:
3-pane viewer collapses to drawers/bottom-sheet on tablet/mobile; test at 360/768/1024/1440.
