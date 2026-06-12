# anchord — Explore docs (v0)

_2026-06-07_

Cluster-by-cluster exploration for anchord v0. Source: design doc
`~/.gstack/projects/claude/administrator-design-20260607-self-hosted-annotation.md`
§4, plus reading the real source (Plannotator OSS, uselink bundle). Stack: Bun + ElysiaJS +
Drizzle + Postgres (see `CLAUDE.md`).

## 8 v0 clusters

| Cluster | File | Core decisions |
|---|---|---|
| render-publish | [render-publish.md](render-publish.md) | iframe `src` + CSP sandbox; MD app-styled / HTML sandboxed; immutable slug + append version; image zoom/pan; cap 5MB/25MB |
| versioning-diff | [versioning-diff.md](versioning-diff.md) | content creates a version; restore = append-copy; **re-anchor + detached**; two-level diff (source + rendered side-by-side) |
| annotation-core | [annotation-core.md](annotation-core.md) | **block-scoped** anchor (uselink) + Plannotator bridge + fuzzy; doc-level; image-region coordinates; flat thread; suggestion = typed + MCP |
| sharing-permissions | [sharing-permissions.md](sharing-permissions.md) | Google-Docs style: 4 roles, 3 general-access modes, anon view + random name, link password/expiry/view-limit, pending invite |
| auth | [auth.md](auth.md) | better-auth; email+pw + GitHub + Google (v0); auto-link if verified; DB session |
| workspace-project | [workspace-project.md](workspace-project.md) | single workspace = instance; members create projects/docs; browse by doc-access; search title + content + comment; notify in-app + email |
| mcp-roundtrip | [mcp-roundtrip.md](mcp-roundtrip.md) | API token + Streamable HTTP; create/update/read/search + pull_annotations + reply/resolve |
| self-host | [self-host.md](self-host.md) | content in Postgres + images on volume; SMTP optional + degrade; no telemetry; single-binary v1 (already watered down) |

**UI sketches:** the ASCII for each screen lives in the `## UI sketches` section of each explore doc
(per the /mf-explore convention, so /mf-plan can route [N]/[E]/[X]) — greenfield, so everything is `[N]`.
Screen↔cluster map: render-publish (New doc + render) · annotation-core (viewer + image
+ mobile) · versioning-diff (history + diff) · sharing-permissions (share dialog) ·
auth (sign-in + first-run) · workspace-project (browser + search + notifications) ·
mcp-roundtrip (settings token) · self-host (no dedicated UI). Design system:
`DESIGN.md` (repo root). Note: self-host says SMTP-optional but this has flipped to
**SMTP required** (see auth C-008 / self-host spec).

## Cross-cutting decisions (read before /mf-plan)

- **Doc identity model:** immutable slug (create) + append immutable version
  (update). Visibility is NOT set at publish — it belongs to sharing (general-access).
- **Anchor:** block-scoped `{ type, block_id, text_snippet, offset, length,
  segments }`, doc-level, `is_orphaned`. Re-anchor on a new version: block_id →
  snippet exact → fuzzy → detached. **annotation-core ↔ versioning-diff are
  bidirectionally coupled — /mf-plan should lock them together.**
  - **block_id = positional hint** (`block-{tag}-{n}`, injected server-side at
    publish) — confirmed by investigating uselink (comparing draft vs published_content). It is NOT
    a stable identity; durability rests on text_snippet + fuzzy + orphan. (Closes /mf-challenge C1.)
- **Render:** untrusted HTML runs inside an iframe sandbox (opaque origin, no
  same-origin) via a content-route + CSP `sandbox` header. dompurify is ONLY for
  content rendered at the app origin (MD, comment) — NOT for sandboxed HTML.
- **Legitimate reuse:** Plannotator `html-viewer` (bridge/postMessage/mark, MIT/
  Apache) — reuse the transport, REPLACE the exact-substring matcher with block-scoped + fuzzy.
  uselink: only learn the model (block anchor, orphan/unorphan), do not take the code.
- **better-auth manages its own auth schema** (`user/session/account/verification`) → the
  initially sketched `users` table defers to it; app tables reference `user.id`.

## Needs reconciling (docs currently out of sync)

- **SQLite → Postgres:** design doc §4.8/§5/§6 still says SQLite; this was changed to
  Postgres (multi-writer workload). `CLAUDE.md` already follows Postgres. During /mf-plan,
  fix the design doc to match.
- **Single-binary:** the design doc's "one file" dream rests on SQLite; with Postgres,
  the v1 single-binary = the app binary + a bundled Postgres, not all-in-one.
- **mf-stack schema:** the design doc starred it ⭐ for v0; per direction it has been **dropped from v0**
  (treat mf-stack docs as ordinary HTML/MD).

## Schema changes vs the sketched `src/db/schema.ts` (reverted)

- `annotations`: drop the `docVersionId` anchor, switch to anchoring on the **doc** + an `anchor jsonb` column
  (block model) + `is_orphaned` + `status`.
- `docs`: add an immutable `slug`.
- `users`: defers to better-auth.
- Add: `doc_shares`/`doc_members`, `share_links`, `api_tokens`, `notifications`,
  FTS index (title + content + comment), blob dedup by content_hash.

## Next step

Each cluster → `/mf-plan` into a spec with acceptance scenarios, then `/mf-build`.
Suggested order: render-publish → versioning-diff + annotation-core (together, due to
the re-anchor coupling) → auth → sharing-permissions → workspace-project →
mcp-roundtrip → self-host.
