## Explore: versioning-diff

_2026-06-07_

**Feature:** Each new content submission creates an immutable version; view history,
restore an old version, and diff between two versions. This is the foundation for the
annotation "anchors durable across versions" capability.

**Trigger:** The author submits new content (upload/paste/MCP) → new version. Restore and
diff are manual actions in the version-history UI.

**UI expectation:** A "Version history" panel on the doc page: list of v1..vN
(time, publisher), a Restore button per version, a "Compare" button to pick 2 versions
→ the diff screen. All **[N] NEW**.

---

### Decisions

**1. What creates a version — only content.**
Each new content submission (upload/paste/MCP update) = a new immutable version,
appended, not overwritten. **Title is mutable metadata on the doc, NOT versioned.**
No draft/autosave in v0 (async, publish-based model — no live editor).

**2. Restore = append-copy (git-revert style).**
Restoring an old version → creates a NEW version that copies the selected version's
content. The history is append-only, nothing is lost, there is no concept of "deleting a
later version". "Current" is always the newest version.

**3. Anchor carry-forward = re-anchor + detached list. (the product's CRUX)**
When version N+1 is created, annotations from version N are **automatically re-anchored**
to the new content via content-hash/fuzzy match:
- Match → the annotation follows to the new version (feedback follows the doc).
- No match → goes into the **"detached"** list for the author/reviewer to relocate or
  resolve.
- **Role split:** the versioning-diff cluster defines the *trigger* (new version → run
  re-anchor for the previous version's annotations) and the *behavior*. The matching
  *algorithm* + the annotation data model (whether an annotation belongs to the doc or to
  a version) belong to the **annotation-core** cluster. This is the mandatory seam between
  the two clusters.

**4. Diff = two-level (per 2026 research), adapted for the sandbox.**
- **HTML:** source/text line-diff (`@pierre/diffs`) **+** rendered side-by-side
  = two sandboxed iframes next to each other (A | B). NO merge-inline-diff in the app origin
  (violates the sandbox model — untrusted HTML does not run in a trusted origin).
- **Markdown:** source line-diff (reads well since MD is plain text) + rendered
  side-by-side (a cheap bonus).
- **Images:** side-by-side. Overlay/swipe → defer.
- Pick **any 2 versions** to compare, not just adjacent ones.
- Avoid the "HTML→MD→diff→back" approach (HtmlDiff is deprecated, gives wrong results).
- Defer: DOM-aware structural diff, inline merged rich-diff.

---

### Happy path

1. The author opens doc "Payment Spec" (at v2), clicks "Version history" → sees v1, v2.
2. Re-uploads the edited `spec.html` → the system creates **v3** (immutable), current = v3.
3. Annotations from v2 run re-anchor: 5/6 comments match → follow to v3; 1 comment
   doesn't match → goes into "detached (1)".
4. The author clicks "Compare v2 ↔ v3" → diff screen: a source column highlights changed
   lines + below it two iframes render v2 | v3 side-by-side.

### Unhappy paths

- **Restore:** the author sees v3 is wrong, clicks "Restore v1" → creates **v4 = copy of v1
  content**. Current = v4. v2/v3 remain in the history. Annotations re-anchor from v3 to
  v4 like any new version.
- **Diffing two identical versions:** comparing 2 versions with identical content → the diff
  screen reports "No differences", the rendered side-by-side still shows.
- **Many detached:** a large edit makes most comments not match → a long detached list; the
  author handles it in the annotation UI (annotation-core cluster), no comment is lost.

---

### Business rules

- Versions are numbered with a continuously incrementing counter v1, v2, v3…, no number reuse.
- Versions are immutable: content + content_hash + publisher + timestamp, not edited
  after creation.
- Current = the highest-numbered version. Restore does not delete, only appends.
- Re-anchor runs synchronously as soon as the new version is created (or as a job right
  after) — details in annotation-core.

### Input validation

- Compare: exactly 2 versions must be selected; comparing a version with itself is not
  allowed (or allowed but reports "no differences").
- Restore: the target version must exist and belong to the doc.

### Permissions

- **View history + diff:** anyone who can view the doc (per the sharing cluster's general-access).
- **Create new version / restore:** editor/owner role (role details owned by the sharing cluster).
  Viewers/commenters cannot create/restore versions.

### Data impact

- `doc_versions` (schema sketched): `version int`, `content text`, `content_hash`,
  `published_by`, `created_at`, unique (doc_id, version).
- Title lives on `docs` (mutable), not on the version.
- Re-anchor needs the annotation model to reference versions — decided in annotation-core
  (annotation belongs to the doc + stores the resolved anchor per version, OR annotation
  belongs to the version + carry-forward creates a copy). Affects the `annotations` schema.

### Out of scope (v0 — defer)

- Custom labels/names for versions + a "commit message" on publish → assumption:
  auto-number only in v0.
- Link pinned to a specific version (`/d/:slug@v2`) → v0 share link = latest. Defer.
- Overlay/swipe for image diff; DOM-aware structural diff; inline merged rich-diff.
- Prune/retention of old versions → keep all in v0 (see the storage open question).
- Real-time / live editor → v2 (async model, no draft).

### Decision rationale

- Append-copy instead of pointer-move: an append-only history is easy to reason about, no
  ambiguity over "where is current", safe for self-host (never loses an old copy).
- Only content creates a version: avoids junk versions from title edits, lighter on storage.
- Two-level diff instead of inline rich-diff: inline requires rendering merged HTML in the
  app origin → breaks the sandbox. Two side-by-side iframes keep isolation while still
  showing the displayed changes.
- Re-anchor + detached: meets the "anchors durable across versions" requirement of the design
  doc §4.2, the payoff differentiator; the detached list ensures feedback is never silently lost.

### Assumptions (need confirmation)

- v0 share link points to latest; no version pinning.
- No version note/message in v0.
- Re-anchor runs synchronously at version creation (fast enough for docs ≤5MB); if slow →
  move to a background job (measure at build time).

### Open questions

- **Storage growth (self-host):** keeping all versions × up to 5MB HTML/25MB images could
  bloat the DB fast. Do we need to compress content, dedup by content_hash (versions with
  identical content stored once), or prune? → couples the **self-host** cluster.
- The annotation model for re-anchor (belongs to doc vs belongs to version) → settled in
  **annotation-core**, feeds back into the version schema.
- How well @pierre/diffs handles raw HTML (token-level or line-level), whether we need to
  pre-normalize the HTML before diffing.
- Image diff side-by-side: do we need to resize to the same dimensions or keep them as-is?

### Complexity signal: **medium-high**

Version + restore + diff on their own are medium. What pushes it to high is the *re-anchor
trigger* and the two-way dependency with annotation-core over the data model — they must be
settled together during /mf-plan, not separately.

### Cross-cluster dependencies

- **annotation-core:** the re-anchor algorithm + annotation model (doc vs version) —
  a two-way constraint, decided at the same time.
- **render-publish:** versions originate from content submitted in that cluster; the sandbox
  iframe is reused for the rendered side-by-side.
- **sharing-permissions:** who views history/diff, who may create a version/restore.
- **mcp-roundtrip:** an MCP doc update = creating a new version (maps onto the trigger here).
- **self-host:** the storage/retention strategy for version history.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW.

**Version history + diff** `[N]` ← S-002 (history) /S-003 (restore append-copy)
/S-004 (diff two-level: source line-diff + rendered side-by-side). Example = a real
v1→v2 diff of annotation-core after /mf-challenge (18→22 AS).
```
┌────────────────────────────────────────────────────────────────┐
│ ⚓ annotation-core                       [Restore v1] [History]  │
├──────────┬──────────────────────────────────────────────────────┤
│ VERSIONS │ Compare v1 ↔ v2 · 2 changes                          │
│  v2 cur  │ ┌── source diff (Geist Mono) ──────────────────────┐ │
│ ▸v1  3h◀ │ │   C-001: anchor block-scoped                     │ │
│          │ │ + block_id is a positional hint (inject publish) │ │ ←teal
│          │ │ + C-008..C-012 harden                            │ │
│          │ └──────────────────────────────────────────────────┘ │
│          │ ┌ v1 rendered ─┐ ┌ v2 rendered ─┐ (≤760: stacked)   │
│          │ │ 18 AS        │ │ 22 AS +4      │                   │
└──────────┴──────────────────────────────────────────────────────┘
```
