## Explore: render-publish

_2026-06-07_

**Feature:** Accept an artifact (HTML / Markdown / image) through several paths, store it as a doc
with an immutable slug + immutable versions, render it safely while still "running for real" so a
recipient can read it through a link.

**Trigger:** Author-initiated — upload file / paste / agent calling MCP. No automatic
triggers (cron/webhook) in v0.

**UI expectation:** A simple "New doc" screen: an upload/paste area, a title field (auto-inferred,
editable), a Publish button. The doc view page = a 2-column layout (content on the left + a right
margin column reserved for annotation in a later cluster). The entire UI is **[N] NEW** — greenfield
repo, nothing yet.

---

### Decisions

**1. Render mode — iframe src + CSP sandbox.**
Each version is served via a content route (`/v/:id/index.html`), rendered with
`<iframe src=... sandbox="allow-scripts">` (NO `allow-same-origin`). The endpoint
also returns a `Content-Security-Policy: sandbox allow-scripts` header to force an opaque
origin even when the URL is opened directly top-level (defense-in-depth).

- JS in AI-generated HTML **runs for real** (live charts/tabs/toggles) but the opaque
  origin → can't read the app's cookies/DOM/localStorage.
- Consequence: **content rendered in the sandbox does NOT need dompurify.** dompurify only applies to things
  rendered in the app's trusted origin (comment body, title, preview). → CLAUDE.md needs an edit:
  the line "all AI HTML goes through dompurify" must spell out "except content rendered
  in a sandbox iframe".
- Don't use `srcdoc` as the primary path, don't use a separate origin/subdomain — keep
  self-host on a single origin.

**2. Markdown routed by format.**
- Plain MD → rendered in the app origin + dompurify (nicely styled in the app theme, deep-link),
  **no JS runs**.
- Need real JS/interactivity → the author publishes as **HTML**, taking the sandbox path.
- Users get "both" at the level of choosing a format at publish time, not mixed in one file.
  The "island" style (embedding a raw-HTML/JS block in a nested iframe) is **deferred to v2**.

**3. Identity + version model (following uselink, adjusted for anchord).**
- `create` → creates a doc with an **immutable slug** + version 1.
- Each push of new content → **appends a new immutable version** (no overwrite).
  The full version/diff/restore semantics belong to the **versioning-diff** cluster.
- render-publish does **not** handle "who can view" — that's the **sharing-permissions**
  cluster (general-access). There's no separate publish/unpublish toggle; "unpublish" ≈ setting
  general-access back to restricted.
- Reference: uselink separates create/update/publish/unpublish; anchord folds visibility
  into sharing to avoid duplicating the concept.

**4. Images are artifacts, with zoom/pan.**
- Display images with zoom in/out + pan. Pinned comments (annotation cluster) anchor to the **original
  image coordinates** (normalized), staying stable across zoom/screen-size changes.
- Raster (PNG/JPG/WebP/GIF) → `<img>` tag. SVG → rendered in a sandbox iframe (may
  contain scripts).

**5. Title auto-inferred + editable.**
- HTML: `<title>` → fallback to first H1. MD: first H1. Image: filename.
- Always let the author edit before publishing (even if an agent passes a title via MCP).

---

### Happy path

1. The author (logged in) opens the "New doc" screen, uploads `spec.html` (1.2MB).
2. The system infers the title from `<title>` = "Payment Spec v2"; the author edits it to
   "Payment Spec".
3. Click Publish → the backend stores the artifact, creates a doc (immutable slug) + version 1, returns
   a link `/d/:slug`.
4. Open the link → HTML renders live in a sandbox iframe, JS runs (tabs/charts
   work). The right margin column is empty (annotation belongs to a later cluster).

### Unhappy paths

- **Over-size:** upload an 8MB `dashboard.html` → exceeds the 5MB cap → rejected before saving,
  reports "File 8.1MB exceeds the 5MB limit". No doc is created.
- **Broken / wrong-type content:** corrupt image → the render frame shows a placeholder "Could not
  read image". A file with a `.md`/`.html` extension but a content-type sniff that doesn't match →
  reports an error, doesn't publish.
- **MCP publish with no doc identity:** an agent calling `publish` without passing a docId
  → creates a **new doc**; with a docId/slug → appends a version. (Cross-cluster: the full
  semantics are in versioning-diff + mcp-roundtrip.)

---

### Business rules

- Per-artifact size cap: **HTML/MD 5MB, image 25MB**. Over → reject with a message
  stating the actual size.
- Each publish of new content = a new immutable version; old versions are not edited.
- The slug is generated once at create time, immutable for the doc's lifetime.
- Content-type is determined by sniffing the content, not just trusting the file extension.

### Input validation

- File upload: allowed types = `.html`, `.md`/`.markdown`, images (png/jpg/webp/gif/svg).
  Other types → reject.
- Title: required, non-empty after inferring/editing; max 255 characters (assumption).
- Paste: content non-empty; choose format HTML or MD (assumption: there's a toggle on paste).

### Permissions

- **Can publish:** a logged-in user who is a member of the workspace (role details defined by
  the sharing/workspace cluster). v0 is single-workspace.
- **Blocked:** a guest who isn't logged in can't publish. (Guests *viewing/commenting* is
  the sharing cluster's job.)

### Data impact

- Tables drafted in `src/db/schema.ts` (reverted, will be rebuilt at build time):
  `docs` (slug, kind, title) + `doc_versions` (version, content, content_hash).
- Need to add: an immutable `slug` column on `docs` (the old schema didn't have it) + storage for the
  served artifact for the content route. Storage: content lives in Postgres
  (`doc_versions.content`); large images are considered for external storage (open question).

### Out of scope (v0 — defer)

- **Importing .zip** (bundled CSS/font/images) → v0.5. Also drops zip-slip/zip-bomb/entry-point.
- **`<img src>` → asset endpoint rewrite** (`publish_with_assets` style) → goes with zip/asset, v0.5.
- **Understanding the mf-stack schema** (S/AS/C/P, ID-as-anchor) → deferred. Treat mf-stack docs like
  plain HTML/MD. (Author's intent: don't insist on mf-stack.)
- **Island** (raw-HTML/JS embedded in MD) → v2.
- Annotating PDFs, annotating live URLs → v2.
- Visibility/sharing, versioning/diff, MCP tool surface → separate clusters.

### Decision rationale

- Sandbox iframe instead of dompurify-strip: because the "HTML runs for real" requirement conflicts
  with sanitizing away JS. Origin isolation solves both. If opaque-origin later turns out not to be
  enough → move to a dedicated sandbox origin (more expensive for self-host).
- iframe `src` instead of `srcdoc`: initially because zip needs to resolve relative paths;
  zip is deferred but `src` is kept for consistency + to avoid an unwieldy srcdoc for large docs.
- Visibility left to the sharing cluster instead of a separate publish/unpublish: avoids two places
  both controlling visibility → reduces the "published but general-access still restricted" bug.
- Defer mf-stack: the author doesn't prioritize it; avoids bloating v0.

### Assumptions (need confirmation)

- Paste has a toggle to choose HTML/MD.
- Title max 255 characters.
- Content (HTML/MD) stored in Postgres; images may need filesystem/volume storage.
- A render failure doesn't crash the app — a broken iframe shows an error state inside the frame,
  doesn't crash the page.

### Open questions

- `@font-face` cross-origin from the opaque-origin iframe back to the app needs a CORS (ACAO) header
  on the content endpoint — confirm at build time.
- Are large images (up to 25MB) stored in Postgres or filesystem/volume? Affects the schema +
  self-host's backup story.
- MCP publish identity: which tool creates a doc, which tool appends a version, what's the identity
  key (docId vs slug)? → settled in the **mcp-roundtrip** cluster (reference uselink:
  create_document / update_document / publish_document).
- Which content-type sniffing lib to use (file-type) and the exact accepted MIME list.
- Whether a large doc (close to 5MB HTML) rendered in an iframe needs lazy/streaming — measure at build time.

### Complexity signal: **medium**

Getting the sandbox render + CSP right is the hardest part; the rest (storing versions, inferring
the title, capping size) is straightforward. Cutting out zip/asset/mf-stack helps reduce the v0 load.

### Cross-cluster dependencies

- **annotation-core:** the right margin column, anchor type 2 (image-region) based on the original
  image coordinates that this cluster builds.
- **versioning-diff:** append version, restore, diff use the `doc_versions` defined here.
- **sharing-permissions:** general-access decides who can open the `/d/:slug` link.
- **mcp-roundtrip:** the create/update/publish tools map into the identity model settled here.
- **self-host:** the image-storage decision (Postgres vs volume) affects backup.

## UI sketches

Dark-operator (see `DESIGN.md`). Greenfield → all `[N]` NEW.

**New doc / Publish** `[N]` ← S-001 (upload/paste/MCP, title auto-inferred, cap 5MB/image 25MB)
```
┌───────────────────────────────────────────────┐
│ ⚓ microvn /            New doc            ✕     │
│ [ ⬤ Upload file ][ Paste ][ ⌥ via MCP ]        │
│ ┌ Drag-drop .html/.md/image  (≤5MB · image ≤25MB) ─┐ │
│ └───────────────────────────────────────────┘ │
│ Format [⬤HTML|Markdown]  Title [ annotation-core ] ← infer <title>/H1, editable │
│                              [ Publish ] ⚓     │
└───────────────────────────────────────────────┘
```

**Render in viewer** `[N]` ← S-002 (HTML sandbox iframe, runs JS) / S-003 (MD app-render)
/ S-004 (image zoom-pan). The viewer frame + chrome is shared with annotation-core (see its UI
sketches: TOC left · doc center · rail right). Render-publish owns the *rendered
content*; annotation-core owns the *annotate overlay*.
