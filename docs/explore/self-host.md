## Explore: self-host

_2026-06-07_

**Feature:** one-line `docker compose up` to self-host anchord; data lives on your own
infrastructure; no telemetry, no phone-home. The reason this project exists.

**Trigger:** Operator installs an instance (first-run setup in the workspace cluster), configures via
env/config.

**UI expectation:** Almost none — it's operations. First-run wizard (workspace cluster)
+ settings (provider toggle, branding, SMTP). **[N] NEW**.

---

### Decisions

**1. Storage = content in Postgres + images on a volume.**
- HTML/MD (content version) stored in Postgres.
- Binary images stored on a **named volume** (configurable path), not crammed into the DB →
  the DB stays small even with many versions.
- S3-compatible object store → add later (v0.5+), don't abstract early in v0.

**2. SMTP = optional + degrade gracefully.**
- SMTP not configured → the instance still runs: drop email verify (or invite via a manually
  copied link), notify only in-app. True to the "one-line" spirit.
- Also removes auth's open question: an internal instance with no SMTP is still usable.

**3. No telemetry (default, v0).**
- No phone-home, no analytics. (uselink has analyticsApi — anchord drops it entirely.)

**4. Dedup versions by content_hash (proposal, keep).**
- Versions with identical content (e.g. restore append-copy) store the blob once by
  content_hash → keep storage in check across version history. (Assumption, confirm at build time.)

**5. Single-binary = v1, already diluted by Postgres.**
- v0: `docker compose up` (app + Postgres + 1 image volume).
- v1: `bun --compile` produces an app binary (embedding the SPA) BUT still needs Postgres running
  alongside — not a one-file-all-in-one like Vaultwarden/SQLite. Still valuable (1 app binary,
  no node_modules) but honest: not "one file".

**6. Backup story.**
- Backup = `pg_dump` (or snapshot the Postgres volume) + the image volume. Document it clearly for
  the operator. (Not "copy one file" like SQLite — a known trade-off.)

---

### Happy path

1. Operator: `git clone` + `cp .env.example .env` (set APP_SECRET, optional SMTP/
   OAuth) → `docker compose up`.
2. compose brings up Postgres + app + image volume; the app runs migrations at boot
   (drizzle-orm migrator), opens the port.
3. Open the browser → first-run setup (workspace cluster): create admin + workspace.
4. Use it right away; with no SMTP, verify is off, notify is in-app.

### Unhappy paths

- **Missing APP_SECRET:** the app refuses to start, reports it clearly (already in the sketched env schema).
- **Postgres not healthy yet:** the app waits for the healthcheck (depends_on condition) before it
  migrates/serves.
- **Image volume not writable (permission):** a clear error when publishing an image, no
  crash.
- **Version upgrade:** new migrations run at boot; if they fail → the app won't serve,
  log it clearly (no half-done startup).

### Business rules

- By default, send no data whatsoever outside the instance.
- Every email-dependent feature must degrade when SMTP is missing.
- Migrations run automatically at boot, idempotent.

### Input validation (config)

- APP_SECRET: required, min 16 characters (already in the sketched `src/config/env.ts`).
- DATABASE_URL: required, valid postgres:// format.
- SMTP_*: optional; if set, validate that host/port/user are complete.
- OAuth provider (GitHub/Google): optional; set client id/secret to enable the provider.

### Data impact

- Postgres: all tables (better-auth + app). Volume `anchord_db` for Postgres.
- New volume `anchord_assets` for images; path configured by `ASSETS_DIR`.
- Table/blob dedup by content_hash (if done).

### Out of scope (v0 — defer)

- Single-binary `bun --compile` → v1.
- S3-compatible object store → v0.5+.
- Helm chart / k8s manifest → v2.
- Auto-update / migration rollback UI → v2.
- Multi-instance / HA → v2 (against the single small instance model).

### Decision rationale

- Images on a volume (not in the DB): many versions × 25MB images crammed into the DB would bloat
  it + make backups heavy; splitting them out keeps the DB lean, still "data on your machine".
- SMTP optional: forcing SMTP at first-run breaks the "one-line" experience; graceful degrade keeps
  the barrier to entry as low as possible.
- Postgres (locked earlier) trades away the single-file dream; accepted because a multi-writer
  workload needs MVCC — recorded honestly, no overselling the single-binary.
- No telemetry: that's exactly the "trust about data" wedge; turning on telemetry would break the sales argument.

### Assumptions (to confirm)

- Dedup content by content_hash done in v0 (or defer?).
- Images on a local volume; no need for S3 in v0.
- Migrations run at boot via the drizzle-orm migrator (already sketched `src/db/migrate.ts`).

### Open questions

- A recommended backup tool/path (script `pg_dump` + tar the image volume) — ship it
  or just document it?
- How do reset/seed differ for dev vs prod?
- Cap total storage/quota on an instance (prevent one workspace eating the whole disk)?
  → related to versioning-diff's version retention.
- Health/readiness endpoint for the reverse-proxy (already sketched `/health`) — is it enough?

### Complexity signal: **low-medium**

Mostly compose + config + degrade logic. Worth noting: image volume + backup
story + migration-on-boot. Single-binary v1 is the hard part (defer).

### Cross-cluster dependencies

- **render-publish / versioning-diff:** images on a volume; dedup versions; cap size.
- **auth:** APP_SECRET (session), OAuth provider env, SMTP for verify/invite.
- **workspace-project:** first-run setup; SMTP for notify; branding/provider toggle
  in workspace settings.
- **mcp-roundtrip:** expose `/mcp`, rate-limit, token storage.
- **annotation-core:** content (with block_id) served from the content-route, images from the volume.

## UI sketches

The self-host cluster has almost no UI of its own — operated via `docker compose` + env/config
(CLI). The only user-facing screen is **First-run setup**, sketched in `auth` UI sketches
(right panel: workspace name + admin + provider toggle + SMTP configured ✓). The rest
is a config file, not a screen.
