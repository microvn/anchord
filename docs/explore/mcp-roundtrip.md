## Explore: mcp-roundtrip

_2026-06-07_

**Feature:** MCP server (same backend process) for agents: publish docs, read/list/
search, pull annotations back to keep editing, and reply/resolve comments. Closes the loop
agent → annotator → agent.

**Trigger:** Agent (Claude/Cursor/Codex…) calls an MCP tool over a connection to the instance.

**UI expectation:** No dedicated UI (it's a server). There is a small UI in settings for the
user to create/revoke a **personal API token**. **[N] NEW**.

---

### References read

- **uselink MCP tools:** read (list/read/search_documents, list_comments,
  list_assets), write (create/update/publish/unpublish/delete_document,
  upload_asset/zip, reply_comment, resolve_comment), orchestrator
  (publish_with_assets — rewrite `<img src>`→CDN). Comments API: list/create/reply/
  moderate/update/delete/**unorphan**, reactions.toggle.
- **better-auth** v1.5 OAuth 2.1 Provider supports MCP agents (defer to v0.5).

---

### Decisions

**1. Agent auth = personal API token (v0).**
- User creates a token in settings; agent puts it in the MCP config (header). The token carries
  that user's rights. OAuth 2.1 (better-auth provider) → v0.5.

**2. Transport = Streamable HTTP.**
- Agent connects to `https://instance/mcp`. Fits self-host (the instance is an existing Elysia
  server), and an agent on another machine can still use it. stdio → not doing in v0.

**3. Tool surface v0 (all 4 groups — full round-trip):**

*Publish:*
- `create_document(content, format, title?)` → creates doc + **immutable slug** + version
  1, **returns docId/slug**. (Resolves render-publish's open question on doc identity.)
- `update_document(docId, content)` → **appends a new version** (no overwrite). Title
  edited separately (mutable metadata).

*Read:*
- `list_documents()` / `read_document(idOrSlug)` / `search_documents(query)` —
  **scoped to the token-owner's rights**.

*Pull annotations (the core half of the round-trip):*
- `pull_annotations(docId)` → returns annotation + comment thread + `status`
  (resolved/unresolved, `is_orphaned`) + suggestion (type delete/replace + proposed
  content) + `anchor` (block_id, `text_snippet`, offset/length) for the agent to locate
  in its own source.

*Write back:*
- `reply_comment(commentId, body)` / `resolve_comment(annotationId)` — agent replies
  / marks resolved after handling.

**4. Visibility is NOT in MCP publish.**
- create/update only create doc + version. "Who can view" is handled by the sharing cluster (general-access).
  An agent could set access via a separate tool → defer to v0.5 (or default by the workspace
  default access policy).

---

### Happy path

1. Agent (Claude Code) holds an API token, calls `create_document(content=spec.html,
   format=html, title="Payment Spec")` → receives `{ docId, slug, url }`.
2. User shares the link, reviewer annotates + suggestion "replace 24h → 48h".
3. Agent calls `pull_annotations(docId)` → receives a list with comment + suggestion
   (type=replace, from="24h", to="48h", text_snippet, block_id).
4. Agent edits source, calls `update_document(docId, content=spec-v2.html)` → creates
   version 2; re-anchor runs (versioning cluster); agent `resolve_comment`s the handled
   items + `reply_comment` "changed to 48h in v2".

### Unhappy paths

- **Wrong/revoked token:** MCP rejects (401), agent gets a clear error.
- **update_document with nonexistent docId / no permission:** rejected; suggests
  create_document if a new doc is wanted.
- **pull_annotations doc heavily orphaned:** returns an `is_orphaned` flag so the agent
  knows which comments are no longer firmly anchored (locate by text_snippet best-effort).
- **search returns docs outside the token's scope:** excluded from results.

### Business rules

- create returns an immutable slug; update always appends a version, never edits an old version.
- Every tool executes under the rights of the token-owning user (their exact doc-access).
- Visibility doesn't change via MCP in v0 (default policy or the user's UI).

### Input validation

- create: content not empty, format ∈ {html, markdown, image}; size cap like
  render-publish (HTML/MD 5MB, image 25MB).
- update: valid docId + token-owner has editor+ rights on the doc.
- reply/resolve: commentId/annotationId belongs to a doc the token-owner can access.

### Permissions

- Token = the user's rights. publish/update need editor+ on the target doc (or creating new =
  becoming owner). pull/read by doc-access. reply/resolve by comment rights.

### Data impact

- Table `api_tokens` (userId, hashed token, name, lastUsedAt, createdAt, revokedAt).
- MCP reuses the doc/version/annotation/comment tables; no separate model for
  content.
- pull_annotations needs to join annotation + comment + anchor (block model in
  annotation-core).

### Out of scope (v0 — defer)

- OAuth 2.1 agent auth (better-auth provider) → v0.5.
- upload_asset / upload_zip / publish_with_assets (rewrite img→asset) → ships with
  zip/asset (v0.5).
- set_access / unpublish via MCP → v0.5.
- unorphan / relocate annotation via MCP → v0.5 (uselink has it; in v0 a person does it on the UI).
- moderate/delete_document/reactions via MCP → v0.5+.
- n8n integration → v2.
- stdio transport → not doing.

### Decision rationale

- API token instead of OAuth in v0: the agent runs local/CI, a header token is the simplest
  self-host approach, no early OAuth flow to build.
- Streamable HTTP: the instance is already a server; a remote/CI agent needs HTTP, stdio is limited.
- Full round-trip (including reply/resolve): user's choice — the "agent edits then marks as
  handled" loop is what truly closes it, not just one-way pull.
- create returns slug + update appends version: matches the identity model locked in
  render-publish/versioning, settles the open question for good.

### Assumptions (to confirm)

- Token carries the user's full rights (no narrower scope) in v0.
- pull_annotations returns both resolved + orphaned (agent filters itself) with enough context to locate.
- Each user can have multiple tokens, name them, revoke them individually.

### Open questions

- Default visibility when an agent creates (no set_access in v0): follow the workspace
  default access policy? or restricted then the user opens it by hand? → couples sharing/workspace.
- How is the suggestion payload standardized so agents can apply it reliably (diff-friendly:
  from/to + block_id + offset)? → couples annotation-core.
- Rate-limit MCP per token (abuse prevention on a self-host instance).
- Does pull support "only annotations new since the last pull" (cursor/since), or
  always full? (proposed: since-cursor so the agent doesn't reprocess).

### Complexity signal: **medium**

MCP SDK + token auth + mapping tools onto existing models is medium. The subtle part: shaping
pull_annotations so the agent can locate + apply suggestions, and since-cursor.

### Cross-cluster dependencies

- **render-publish / versioning-diff:** create/update = create doc + append version;
  size cap; trigger re-anchor.
- **annotation-core:** pull_annotations shape (anchor block model, suggestion,
  orphaned); reply/resolve.
- **sharing-permissions:** default access for docs an agent creates; rights by token-owner.
- **auth:** token issuance (better-auth user); OAuth 2.1 provider for v0.5.
- **workspace-project:** which workspace/project a doc the agent creates belongs to (default project?).
- **self-host:** endpoint `/mcp` expose, rate-limit, token storage.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW. This cluster is mostly API; the only
UI is the settings token page.

**Settings — API token** `[N]` ← S-001 (personal token, hashed/revoke, C-008);
Streamable HTTP; tools create/update/read/search/pull/reply/resolve
```
┌───────────────────────────────────────────────┐
│ Settings › API tokens (for MCP / agent)        │
│ [ + New token ]                                │
│ ┌───────────────────────────────────────────┐ │
│ │ "claude-code"  ·  last used 2h  ·  [Revoke]│ │
│ │ "ci-publish"   ·  last used 5d  ·  [Revoke]│ │
│ └───────────────────────────────────────────┘ │
│ MCP: https://instance/mcp  (Streamable HTTP)   │
│ Tools: create/update · read/list/search ·      │
│        pull_annotations · reply/resolve        │
└───────────────────────────────────────────────┘
```
