<div align="center">

# Anchord

**Self-hosted, own-your-data platform to share and annotate AI-generated docs.**
_Vaultwarden for AI docs — publish a spec/plan/report as a link, get margin comments back, and let your agent pull the feedback over MCP. Your data never leaves the box._

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
![Status: v0 — active development](https://img.shields.io/badge/status-v0%20·%20active%20development-orange.svg)
![Self-hosted](https://img.shields.io/badge/self--hosted-docker%20compose-2496ED.svg)
![Built with Bun](https://img.shields.io/badge/runtime-Bun-000000.svg)

</div>

---

<!-- Drop a GIF of the 3-pane viewer (doc + margin comments) here, e.g. docs/assets/anchord.gif -->

An author generates a doc in Claude / Cursor / Codex and publishes it as a link. Reviewers open it, read the rendered doc, and leave **comments, highlights, and suggestions** in a right-hand margin — no account required if the author allows it. The author revises, republishes a new **version**, and the annotations **re-anchor** onto the new content (or land in a "detached" list, never lost). An agent pulls the feedback back over **MCP** to revise. Everything runs on your own infrastructure.

The viewer is a **3-pane** layout: a table-of-contents rail, the rendered doc (in a sandboxed iframe that keeps the doc's own styling), and a margin of comment threads.

## Why Anchord

Sharing-and-annotating AI docs is usually a hosted SaaS with per-seat pricing and your content on someone else's servers. Anchord trades that for two things you can't get from the hosted tools:

- **Own your data.** `docker compose up` on your own box. Content text lives in your Postgres; image uploads live on your volume. **No telemetry, no phone-home, ever.**
- **Free collaboration.** No per-seat tax — invite your whole workspace, share a link with guests, annotate without limits.

The differentiator is **own-your-data + free collaboration**, not "prettier than the SaaS." License is **AGPL-3.0** to keep it that way.

## Features

| | |
|---|---|
| 📝 **Annotate AI docs** | Select a text range or an image region on a rendered HTML/Markdown doc → leave a comment, highlight, or suggestion in the margin. Flat reply threads, resolve/reopen. |
| 🔢 **Versioning + diff** | Every publish appends an immutable version. Annotations re-anchor across versions (content-anchored, not position-anchored); non-matches go to a "detached" list, never dropped. |
| 👥 **Sharing & roles** | Per-doc roles (viewer / commenter / editor / owner) + general access (restricted / anyone-with-link / anyone-in-workspace). Guest commenting (name, optional email — no account). |
| 🏢 **Multi-workspace** | Each account gets a default workspace; create more, invite/remove members, switch. Tenancy is path-scoped. |
| 🤖 **MCP round-trip** | Agents publish docs and **pull annotations** back over a built-in MCP server — the revise loop, automated. See [Agent / MCP integration](#agent--mcp-integration). |
| 🔐 **Self-host auth** | Email + password, magic link, and GitHub / Google OAuth (each optional). Server-side revocable sessions. |

> **Status:** Anchord is in active early development (**v0**). The core — annotate → version → re-anchor → MCP pull — works end-to-end; expect rough edges and breaking changes before a tagged release.

## Quick start

**Prerequisites:** Docker + Docker Compose.

```bash
git clone <your-fork-or-this-repo> anchord && cd anchord
cp .env.example .env
```

Set two things in `.env` before bringing it up — the app **fail-closes at boot** without them:

1. `APP_SECRET` — any 16+ character random string (signs sessions, share-link tokens, and access tokens).
2. An **email provider** — a full SMTP group (`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`) **or** a `RESEND_API_KEY`. Email verification and magic-link sign-in require it; the app refuses to start otherwise.

```bash
docker compose up           # postgres + app; migrations run automatically on boot
```

Open **<http://localhost:3000>** — sign up, and your default workspace + project are created automatically. Health probe: `GET /health`.

> One container serves the API, the built web app, and the MCP server on the same origin (`:3000`). Postgres and your image assets live in named Docker volumes on your machine.

## Local development

Anchord is a Bun workspace monorepo (`apps/*` + `packages/*`). For hot-reload development you run the backend and the Vite web dev server separately, with Postgres from Docker:

```bash
bun install
docker compose up -d db                # Postgres only
cp .env.example .env                    # dev defaults are fine (NODE_ENV=development)

bun run dev          # backend  → http://localhost:3000  (API + MCP)
bun run dev:web      # web (Vite, separate shell) → http://localhost:5173, proxies to the backend
```

Common scripts:

```bash
bun test                 # backend unit tests (fast, mocked)
bun run test:integration # backend integration tests (real Postgres)
bun run test:web         # web unit tests
bun run typecheck        # backend typecheck    ·    bun run typecheck:web
bun run db:generate      # drizzle-kit: generate a migration from schema changes
bun run db:migrate       # apply migrations
```

## Configuration

All config is via environment variables (`.env.example` is the template). The ones that matter:

| Var | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection — the source of truth | `postgres://anchord:anchord@localhost:5432/anchord` |
| `APP_SECRET` | Signs sessions, share-link tokens, and access tokens | **required** (min 16 chars) |
| `SMTP_HOST` · `SMTP_PORT` · `SMTP_USER` · `SMTP_PASS` | Email provider (verification, magic link, notifications) | **required group** unless `RESEND_API_KEY` is set |
| `RESEND_API_KEY` | Alternative email provider (wins over SMTP when both are set) | optional |
| `PORT` | HTTP port (serves API + web + MCP) | `3000` |
| `ASSETS_DIR` | Where image uploads are stored on disk (text lives in Postgres) | `/data/assets` |
| `CORS_ORIGIN` | Allowed web origin — set to your domain in production, never wildcard | `*` |
| `GITHUB_CLIENT_ID` · `GITHUB_CLIENT_SECRET` | Enable GitHub sign-in (both present, or the button stays off) | optional |
| `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET` | Enable Google sign-in (both present, or off) | optional |

> **Fail-closed at boot:** a missing `APP_SECRET`, a missing `DATABASE_URL`, or no email provider throws on startup — so a half-configured instance never silently runs with a guessable secret or a broken sign-up flow. An OAuth provider is enabled only when **both** its id and secret are present (never half-on).

## Agent / MCP integration

Anchord ships a built-in **Model Context Protocol** server so an AI agent can drive the publish → review → revise loop without a human in the middle. This is Anchord's wedge: the doc your agent wrote, the feedback it gets, and the revision it makes all flow through one self-hosted endpoint.

1. **Create a Personal Access Token** in the web app: **Settings → Developer → Create token** (pick a workspace + scopes). The plaintext token (`anch_pat_…`) is shown once.
2. **Point your MCP client** at the endpoint with the token as a bearer:

   ```
   URL:    http://localhost:3000/mcp
   Header: Authorization: Bearer anch_pat_…
   ```

3. **Use the tools.** The server exposes document, annotation, comment, and project tools — including:
   - `anchord_create_document` / `anchord_update_document` — publish a new doc or a new version.
   - `anchord_pull_annotations` — pull the reviewers' feedback back (incremental, watermark-based).
   - `anchord_list_comments` · `anchord_reply_comment` · `anchord_resolve_comment` — work the threads.
   - `anchord_read_document` · `anchord_list_documents` · `anchord_search_documents` · project tools.

Tokens are scoped (`docs:read/write`, `annotations:read/write`, `projects:read/write`), bound to one workspace, and rate-limited. Transport is MCP Streamable HTTP (`@modelcontextprotocol/sdk`).

## How it works

**Domain model** — a three-tier hierarchy:

```
Workspace (tenant: members, auth)
  └─ Project (group of related docs)
       └─ Doc (artifact)
            └─ Version (immutable; one per publish)
                 └─ Annotation (anchors to a Version) ─ thread of ─ Comment
```

**Stack & why:**

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun** | Native TS, fast cold start, a `bun --compile` single-binary path for self-host. |
| Backend | **ElysiaJS** | Bun-native, fast, end-to-end typed. |
| Database | **PostgreSQL + Drizzle** | Multiple reviewers commenting on one doc is a multi-writer workload; Postgres MVCC handles it. Drizzle keeps the schema portable. |
| Sanitize | **isomorphic-dompurify** | Rendering AI-generated HTML is the main XSS surface — everything passes through DOMPurify before render or storage. |
| MCP | **@modelcontextprotocol/sdk** | Same process as the backend. |
| Frontend | **React 19 + Vite + Tailwind 4** | Reuses Plannotator's annotation editor (the hard select-text → margin-comment → anchor part). |

**Re-anchoring** is the heart of the product: an annotation anchors to text by content (block-id hint → whole-document text fallback → W3C-style quote + prefix/suffix context → fuzzy match), so it survives across versions instead of breaking on the first edit. A genuinely deleted span detaches into a list you can re-attach or dismiss — annotations are never silently lost or mis-anchored.

For the full design, ADRs, and the behaviour contract (stories / acceptance scenarios / constraints), see [`docs/`](docs/).

## Roadmap

**In v0:** async annotation (read → comment → author revises later), versioning + diff, sharing/roles, multi-workspace with full UI, basic search, reply notifications, MCP publish + pull-annotations, `docker compose up`.

**Explicitly deferred:** real-time multi-editor collaboration (CRDT/OT — async covers ~90% of the value), PDF / live-URL annotation, a visual no-code editor, editor integrations, and OIDC/SAML SSO (the self-host advantage — lands v0.5+).

## Operating

- **Upgrading:** `git pull` (or pull the new image) and `docker compose up --build`. Migrations are applied automatically at boot from committed SQL — **back up your Postgres volume first**.
- **Backup:** dump Postgres (`pg_dump`) and snapshot the `anchord_assets` volume. Content text is in Postgres; image uploads are on the assets volume.

## Testing

The codebase is **tested thoroughly** — **1,500+ automated tests** across the backend, web, and shared packages, and the suite is **spec-traceable**: **over 1,000 tests are named by the acceptance scenario (`AS-NNN`) or constraint (`C-NNN`) they cover.** Behaviour is written as a spec first (`docs/specs/`, as stories / acceptance scenarios / constraints) and every scenario earns a test, so coverage maps one-to-one to the contract.

The split is deliberate — a test runs where its correctness actually lives:

- **Backend unit** (63 suites, mocked, fast) — logic decidable without a database.
- **Backend integration** (24 suites, **real Postgres**) — logic whose correctness *is* the SQL / async behaviour: atomic version append, the cross-version re-anchor matcher + its idempotent resolution ledger, access resolution, and the incremental changed-since watermark. A mocked test there would be vacuous.
- **Web unit** (76 suites, React Testing Library).

```bash
bun test                  # backend unit (fast, mocked)
bun run test:integration  # backend integration (real Postgres — set DATABASE_URL)
bun run test:web          # web (React Testing Library)
bun run typecheck         # backend    ·    bun run typecheck:web
```

## Project layout

```
apps/backend/    Bun + ElysiaJS API · Drizzle schema/migrations · MCP server · annotation re-anchor engine
apps/web/        React 19 + Vite + Tailwind — feature-based (features/{docs,viewer,sharing,settings,…})
packages/anchor/ @anchord/anchor — shared selection→anchor + locate ladder (FE + in-iframe bridge)
anchord-e2e/     End-to-end flow screenshots / manual QA captures
docs/            specs/ (behaviour contracts: S/AS/C) · explore/ (design rationale)
docker-compose.yml · Dockerfile   self-host packaging (app + Postgres + named volumes)
```

## Contributing

Issues and pull requests are welcome. The repo is spec-first: behaviour lives in `docs/specs/` as stories / acceptance scenarios / constraints, and code serves the spec. Please run `bun run typecheck && bun test` before opening a PR, and keep the frontend conventions in [`apps/web/FRONTEND.md`](apps/web/FRONTEND.md).

## Security

Anchord stores other people's documents and comments — security reports matter. Please report vulnerabilities **privately** to the maintainers (do not open a public issue). Rendering AI-generated HTML is the primary attack surface and is sandboxed + sanitized; if you find a way around it, we want to know.

## Acknowledgements

Anchord was built with the help of:

- **[Claude Code](https://claude.ai/code)** + **[claude-devkit](https://bitbucket.org/mobilefolkteam/claude-devkit)** — the spec-first workflow (`/mf-explore → /mf-plan → /mf-build → /mf-fix`) that drives this repo: behaviour is written as stories / acceptance scenarios / constraints first, then code serves the spec.
- **[GraphAtlas](https://github.com/microvn/graphatlas)** — graph-based code intelligence (call/import/reference graph over MCP) used for discovery, blast-radius, and review during development.

## License

**[AGPL-3.0](LICENSE).** Anchord is free software; if you run a modified version as a network service, you must make your source available. This is deliberate — it keeps own-your-data + free collaboration the default for everyone.
