# Snapshot: self-host
**Date:** 2026-06-22
**Ref:** --
**Reason:** M1 (new story S-005: build + serve the frontend app from the self-host image)

---

# Spec: self-host

**Created:** 2026-06-07
**Last updated:** 2026-06-22
**Status:** Draft

## Overview

`docker compose up` to self-host anchord: app + Postgres + volume; migrations run at
boot; required config is validated (if missing, it won't start). Text content lives in
Postgres, images on a volume. No telemetry, no phone-home. The reason this project exists.

## Data Model

- No new business entity. Infrastructure:
  - Volume `anchord_db` (Postgres data) + `anchord_assets` (images, path `ASSETS_DIR`).
  - Config via env: `APP_SECRET`, `DATABASE_URL`, `APP_URL` (the public base URL the
    instance builds absolute deep-links from — **boot-mandatory**, must be an absolute
    `http(s)://` URL), an email provider (`SMTP_*` **or** `RESEND_API_KEY` — at least one
    mandatory; both → Resend API wins), OAuth `GITHUB_*`/`GOOGLE_*` (optional), `ASSETS_DIR`,
    `CORS_ORIGIN`, `PORT`.
  - `APP_PORT` (optional, compose-level): the HOST port the app is published on. Defaults to the
    in-container `PORT` (3000); an operator whose host 3000 is taken remaps via `APP_PORT` without
    changing `PORT`. Host-side mapping only — never seen by the app process.
  - Postgres credentials (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`) are **operator-set
    via `.env`**, NOT baked into the compose file — a self-host instance must never ship a fixed
    default DB password. The app's `DATABASE_URL` is composed from the same values so the two can
    never drift. Sensible non-secret defaults are allowed for the user/db NAME, but the PASSWORD
    must be operator-supplied (no shipped default). (C-002, C-006)
  - (Optional) blob dedup by `content_hash` for versions with identical content.

## Stories

### S-001: Bring up the stack with docker compose (P0)

**Description:** As an operator, I run `docker compose up` and get a working instance:
Postgres comes up, migrations run, the app serves.
**Source:** docs/explore/self-host.md#decisions, #happy-path.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (`docker-compose.yml`, `Dockerfile`, `src/db/migrate.*`, env schema)
- `autonomous:` true
- `verify:` `docker compose up` with a valid .env → `/health` returns ok after Postgres is healthy + migrations complete.

**Acceptance Scenarios:**

AS-001: compose up brings up a working instance
- **Given:** a valid `.env` (APP_SECRET, DATABASE_URL, APP_URL, SMTP_*)
- **When:** running `docker compose up`
- **Then:** Postgres comes up (healthcheck), the app waits for healthy then runs migrations (idempotent)
  and serves; `/health` returns ok
- **Data:** default compose + valid .env

AS-002: App waits for Postgres healthy before migrate/serve
- **Given:** Postgres is not ready when the app starts
- **When:** the app boots
- **Then:** the app waits for the Postgres healthcheck before it migrates + serves (no half-done startup)
- **Data:** Postgres starts slowly

### S-002: Validate required config at boot (P0)

**Description:** As an operator, if I'm missing required config, the app refuses to start and
clearly reports what's missing.
**Source:** docs/explore/self-host.md#unhappy-paths; auth C-008 (SMTP required).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (`src/config/env.*`)
- `autonomous:` true
- `verify:` drop APP_SECRET → app won't start, log states it clearly; drop every email provider (no SMTP_* and no RESEND_API_KEY) → same.

**Acceptance Scenarios:**

AS-003: Missing APP_SECRET → refuse to start
- **Given:** `.env` missing APP_SECRET (or < 16 characters)
- **When:** the app boots
- **Then:** the app won't start; the log clearly states APP_SECRET is missing/invalid
- **Data:** empty APP_SECRET

AS-004: Missing email provider → refuse to start
- **Given:** `.env` configures NO email provider (neither `SMTP_*` nor `RESEND_API_KEY`)
- **When:** the app boots
- **Then:** the app won't start; the log clearly states an email provider is required (consistent with auth C-008)
- **Data:** empty SMTP_* and no RESEND_API_KEY

AS-008: Missing or non-absolute APP_URL → refuse to start
- **Given:** `.env` is missing `APP_URL`, or sets it to a value that is not an absolute `http(s)://` URL
- **When:** the app boots
- **Then:** the app won't start; the log clearly states `APP_URL` is missing/invalid (it must be an absolute `http(s)://` base, since notification deep-links and invite accept-links are built from it)
- **Data:** unset APP_URL; also `APP_URL=notaurl` and a relative `APP_URL=/d/spec`

AS-009: Missing Postgres password → bring-up refused (no shipped default)
- **Given:** `.env` does not set `POSTGRES_PASSWORD` (the compose file ships no default password)
- **When:** running `docker compose up`
- **Then:** the bring-up is refused with a clear message naming `POSTGRES_PASSWORD`; no instance comes up with a guessable default credential
- **Data:** `.env` with POSTGRES_PASSWORD unset

### S-003: Store images on a volume, content in Postgres (P1)

**Description:** As the system, I store text content in Postgres and images on a configurable
volume.
**Source:** docs/explore/self-host.md#decisions (item 1 storage).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (asset storage path)
- `autonomous:` true

**Acceptance Scenarios:**

AS-005: Images stored on the volume, content in the DB
- **Given:** a running instance with an assets volume
- **When:** publishing one image doc and one HTML doc
- **Then:** image bytes live on the volume (`ASSETS_DIR`); HTML content lives in Postgres;
  both can be served
- **Data:** 1 image + 1 HTML

AS-006: Image volume not writable → clear error
- **Given:** `ASSETS_DIR` is not writable
- **When:** publishing an image
- **Then:** a clear error at publish time; the app doesn't crash
- **Data:** a read-only directory

### S-004: No telemetry by default (P1)

**Description:** As a data-conscious operator, I'm assured that the instance does not send
data outside.
**Source:** docs/explore/self-host.md#decisions (item 3 no telemetry).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: No phone-home / analytics
- **Given:** an instance running normally
- **When:** operating (publish, annotate, search…)
- **Then:** no request goes to an external service for telemetry/analytics purposes (it only
  reaches out when needed: sending email via configured SMTP, OAuth to an enabled provider)
- **Data:** monitor outbound during use

## Constraints & Invariants

- C-001: `docker compose up` brings up app + Postgres + volume (`anchord_db`,
  `anchord_assets`); migrations run at boot, idempotent, and if they fail the app won't serve. (AS-001, AS-002)
- C-002: Required config (APP_SECRET ≥16, DATABASE_URL, `APP_URL` as an absolute `http(s)://`
  base, an email provider — `SMTP_*` **or** `RESEND_API_KEY`) validated at boot; missing/invalid →
  refuse to start with a clear log naming the bad key. (AS-003, AS-004, AS-008)
- C-003: Text content in Postgres; binary images on a volume (`ASSETS_DIR`). (AS-005)
- C-004: No telemetry/phone-home by default; outbound only for configured SMTP/OAuth. (AS-007)
- C-005: Storage errors (volume not writable) reported clearly, no crash. (AS-006)
- C-006: Postgres credentials come from the operator's `.env`, never hardcoded in the compose file;
  no fixed default DB PASSWORD ships. The app's `DATABASE_URL` is composed from the same `.env`
  values (user/password/db) so app and database can never disagree on credentials. A missing
  `POSTGRES_PASSWORD` stops the bring-up with a clear message. (AS-009)

## Linked Fields

- **Email provider config (required)** — produced by self-host (env validate, C-002): `SMTP_*`
  **or** `RESEND_API_KEY`. Consumed by `auth` (verify/invite), `workspace-project` (notify). ✔
  self-host guarantees an email provider is always present, so those clusters don't need to degrade.
- **`ASSETS_DIR` / image volume** — produced by self-host (C-003). Consumed by
  `render-publish` (store/serve images) + `annotation-core` (image-region). ✔.

## What Already Exists

### System Impact & Technical Risks

- Repo is greenfield. `docker-compose.yml`/`Dockerfile`/`src/db/migrate.ts`/`src/config/env.ts`
  were sketched once (now reverted) — rebuild them per this spec.
- Cross-spec: SMTP-required locks into `auth`/`workspace-project`; ASSETS_DIR locks into
  `render-publish`.
- Risk: migration-on-boot must be idempotent + fail-closed (don't serve if migrate
  fails). Single-binary v1 is the hard part, defer.

## Not in Scope

- Single-binary `bun --compile` → v1 (and already diluted: still needs Postgres alongside).
- S3-compatible object store for images → v0.5+.
- Helm chart / k8s manifest → v2.
- Auto-update / migration rollback UI → v2.
- Multi-instance / HA → v2.

## Gaps

- GAP-001 (status: open): dedup content by content_hash (identical versions stored
  once) — do it in v0 or defer? Affects storage growth (versioning-diff GAP-001).
  Source: "Dedup content by content_hash done in v0 (or defer?)".
- GAP-002 (status: open): ship a backup script (`pg_dump` + tar the image volume) or
  just document it? Source: "Recommended backup tool/path … ship it or document".
- GAP-003 (status: open): cap total storage/quota on an instance (prevent one
  workspace eating the whole disk)? Related to version retention. Source: "Cap total
  storage/quota on an instance".

## Clarifications — 2026-06-07

- **Storage: content in Postgres + images on a volume:** many versions × large images crammed
  into the DB would bloat it + make backups heavy; splitting them out keeps the DB lean, still
  "data on your machine".
- **EMAIL PROVIDER REQUIRED (reversing the explore "optional + degrade"):** the app won't start
  if no email provider is configured (`SMTP_*` or `RESEND_API_KEY`) → drop all degrade logic;
  email verify/invite/notify always work. Consistent with `auth` C-008. (Generalized 2026-06-07
  from SMTP-only to SMTP-or-Resend-HTTP-API; both → Resend API wins.)
- **Postgres (locked earlier) dilutes the single-file dream:** v1 single-binary =
  app binary + Postgres alongside, not all-in-one; honest, no overselling.
- **No telemetry:** that's exactly the "trust about data" wedge.
- **Email runtime (from /mf-challenge H6):** required at boot is DIFFERENT from being able-to-send at
  runtime; outbound mail enqueue + retry + dead-letter + an error state for the operator (details
  in `auth` C-009), via whichever transport (SMTP or Resend API). Boot still fails fast if no
  email provider is configured.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/self-host.md); SMTP required (reverses explore) | -- |
| 2026-06-07 | /mf-challenge harden H6: record SMTP runtime retry/dead-letter (auth C-009) | -- |
| 2026-06-07 | Major: email provider generalized SMTP→(SMTP or Resend HTTP API) — AS-004 + C-002 + Linked Field + clarifications, mirroring auth C-008 | snapshot 2026-06-07.md |
| 2026-06-22 | Major (M4/M6): APP_URL now boot-mandatory (Data Model + AS-001 Given + C-002 + new AS-008); APP_PORT host-port override (Data Model). Found during self-host build: compose didn't pass APP_URL → app exit(1) | snapshot 2026-06-22-app-url-port.md |
| 2026-06-22 | Major (M6): DB credentials operator-set via `.env`, no shipped default password, DATABASE_URL composed from same values (Data Model + new C-006 + AS-009) | snapshot 2026-06-22-app-url-port.md |
