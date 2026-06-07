# Spec: mcp-roundtrip

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

MCP server (cùng process backend, Streamable HTTP tại `/mcp`) cho agent: publish doc
(create/update), đọc/list/search, pull annotations về để sửa tiếp, và reply/resolve
comment. Agent xác thực bằng personal API token. Khép vòng agent → người annotate →
agent.

## Data Model

- **api_tokens**: `id`, `user_id`, `token_hash`, `name`, `last_used_at`,
  `created_at`, `revoked_at`.
- Tái dùng doc/version/annotation/comment; không thêm model riêng cho nội dung.

## Stories

### S-001: Authenticate agent with a personal API token (P0)

**Description:** Là người dùng, tôi tạo (và thu hồi) API token để agent gọi MCP dưới
quyền của tôi.
**Source:** docs/explore/mcp-roundtrip.md#quyết-định (mục 1 agent auth, mục 2 transport).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (token issuance + MCP server mount tại /mcp)
- `autonomous:` true
- `verify:` tạo token → agent gọi MCP OK; thu hồi token → gọi bị từ chối.

**Acceptance Scenarios:**

AS-001: Tạo token và gọi MCP thành công
- **Given:** user tạo một API token trong settings
- **When:** agent gọi một MCP tool với token trong header tới `/mcp` (Streamable HTTP)
- **Then:** request thực thi dưới quyền của user đó
- **Data:** token hợp lệ

AS-002: Token sai/thu hồi bị từ chối
- **Given:** một token đã bị thu hồi (hoặc chuỗi token sai)
- **When:** agent gọi MCP với token đó
- **Then:** từ chối; agent nhận lỗi xác thực rõ
- **Data:** token revoked

### S-002: Publish via MCP — create & update (P0)

**Description:** Là agent, tôi tạo doc mới (nhận docId/slug) và cập nhật doc đã có
(append version mới).
**Source:** docs/explore/mcp-roundtrip.md#quyết-định (mục 3 tool publish).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (map vào model danh tính của render-publish/versioning)
- `autonomous:` true
- `verify:` create_document → trả docId/slug + v1; update_document(docId) → xuất hiện v2.

**Acceptance Scenarios:**

AS-003: create_document tạo doc + slug + version 1
- **Given:** agent đã xác thực
- **When:** gọi `create_document(content, format, title?, projectId?)`
- **Then:** tạo doc với slug bất biến + version 1, general_access = **restricted**
  (riêng token-owner), nằm trong default project của token-owner nếu thiếu projectId;
  trả về `{ docId, slug, url }`
- **Data:** content HTML + title "Payment Spec", không truyền projectId

AS-004: update_document append version mới
- **Given:** một doc đã tồn tại (docId), agent có quyền editor+ trên doc
- **When:** gọi `update_document(docId, content)`
- **Then:** append version mới (không ghi đè); kích hoạt re-anchor (versioning/annotation)
- **Data:** docId + content đã sửa

AS-005: update_document docId không tồn tại / không có quyền bị từ chối
- **Given:** agent gọi update với docId không tồn tại hoặc không có quyền editor
- **When:** thực thi
- **Then:** từ chối; gợi ý create_document nếu muốn doc mới
- **Data:** docId lạ / token-owner chỉ có quyền viewer

### S-003: Read via MCP — list / read / search (P1)

**Description:** Là agent, tôi liệt kê, đọc và tìm doc trong phạm vi quyền của
token-owner.
**Source:** docs/explore/mcp-roundtrip.md#quyết-định (mục 3 read).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-006: list/read/search trong phạm vi quyền
- **Given:** token-owner có quyền một số doc
- **When:** agent gọi `list_documents` / `read_document(idOrSlug)` / `search_documents(query)`
- **Then:** chỉ trả doc token-owner có quyền; doc ngoài quyền không xuất hiện
- **Data:** query khớp cả doc trong và ngoài quyền

### S-004: Pull annotations (P0)

**Description:** Là agent, tôi kéo annotations của một doc về để định vị và sửa
trong source của mình.
**Source:** docs/explore/mcp-roundtrip.md#quyết-định (mục 3 pull annotations).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: pull_annotations trả đủ ngữ cảnh định vị
- **Given:** doc có annotation (gồm resolved, orphaned) + suggestion
- **When:** agent gọi `pull_annotations(docId)`
- **Then:** trả annotation + comment thread + `status` (resolved/unresolved,
  is_orphaned) + suggestion (type delete/replace + nội dung) + anchor (block_id +
  text_snippet) để agent định vị trong source
- **Data:** doc có 1 comment + 1 suggestion replace + 1 orphaned

AS-008: pull chỉ lấy annotation mới từ lần trước (since-cursor)
- **Given:** agent đã pull trước đó với một cursor
- **When:** gọi pull với cursor đó
- **Then:** chỉ trả annotation/comment mới hoặc đổi từ cursor, không lặp lại cái đã xử
- **Data:** cursor lần trước + 2 comment mới

### S-005: Write back — reply & resolve (P1)

**Description:** Là agent, sau khi xử lý feedback tôi trả lời và đánh dấu resolve.
**Source:** docs/explore/mcp-roundtrip.md#quyết-định (mục 3 write back).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: reply_comment và resolve_comment
- **Given:** một annotation có comment, token-owner có quyền comment trên doc
- **When:** agent gọi `reply_comment(commentId, body)` rồi `resolve_comment(annotationId)`
- **Then:** reply thêm vào thread (flat); annotation chuyển resolved
- **Data:** reply "đã đổi thành 48h ở v2" + resolve

AS-010: token hashed + pull authorize per-doc [harden H4]
- **Given:** một token; token-owner có quyền doc A, không có quyền doc B (restricted)
- **When:** agent gọi `pull_annotations(B)`; và quan sát lưu trữ token
- **Then:** pull(B) bị từ chối (authorize per-doc theo owner); token lưu dạng hash,
  không lộ plaintext; revoke token thì mọi gọi sau bị từ chối
- **Data:** token-owner ∉ quyền doc B

## Constraints & Invariants

- C-001: Token = quyền của user sở hữu; token thu hồi/sai → từ chối. (AS-001, AS-002)
- C-002: create → slug bất biến + version 1 + trả docId; update → append version
  (không ghi đè), cần quyền editor+. (AS-003, AS-004, AS-005)
- C-003: list/read/search chỉ trả doc token-owner có quyền. (AS-006)
- C-004: pull_annotations trả status (resolved/orphaned) + suggestion + anchor
  (block_id + text_snippet) đủ để agent định vị. (AS-007)
- C-005: Transport Streamable HTTP tại `/mcp`. (AS-001)
- C-006: Visibility KHÔNG đặt qua MCP ở v0; doc agent tạo mặc định **restricted**
  (riêng token-owner), vào default project của token-owner nếu thiếu projectId. (AS-003)
- C-007: MCP có rate-limit theo token. (AS-002)
- C-008 [harden H4]: api_tokens lưu HASHED (không plaintext), hiện một lần lúc tạo,
  revoke từng cái, có `last_used_at` + expiry optional, scope tối thiểu read vs write;
  pull/read/write authorize per-doc/per-annotation như web path theo owner token. (AS-010)

## Linked Fields

- **docId/slug + version** — produced bởi mcp:S-002 (create/update), khớp model danh
  tính của `render-publish`/`versioning-diff`. ✔ cùng một model doc+version.
- **anchor + suggestion + status** — produced bởi `annotation-core` (Data Model).
  Consumed bởi mcp:S-004 (AS-007) để trả cho agent. ✔ pull đọc đúng model block-anchor.
- **default project của user** — produced bởi `workspace-project` (mỗi tài khoản
  tự tạo một default project). Consumed bởi mcp:S-002 (AS-003) làm nơi chứa doc agent
  tạo khi thiếu projectId. ✔ workspace-project tạo default project per-user (C-009 ở
  spec đó).

## UI Notes

Từ `docs/explore/mcp-roundtrip.md` §UI sketches. Greenfield → `[N]`. Cụm chủ yếu là
API; UI duy nhất là settings token. Component names only. Dark-operator (`DESIGN.md`).

- `ApiTokenSettings` `[N]`
  - `NewTokenButton` *(hiện token plaintext một lần — C-008)*
  - `TokenList` → `TokenRow`: name · lastUsed · `RevokeButton`
  - `McpEndpointInfo` *(/mcp Streamable HTTP + danh sách tools)*

## What Already Exists

### System Impact & Technical Risks

- Repo greenfield. MCP server cùng process Elysia, dùng `@modelcontextprotocol/sdk`.
- Cross-spec: create/update = doc+version (`render-publish`/`versioning-diff`); pull/
  reply/resolve dùng model `annotation-core`; token gắn user (`auth`); endpoint `/mcp`
  + rate-limit (`self-host`).
- Reuse: không tạo model nội dung riêng — MCP là một mặt API trên model có sẵn.

## Not in Scope

- OAuth 2.1 agent auth (better-auth provider) → v0.5 (v0 dùng API token).
- upload_asset / upload_zip / publish_with_assets (rewrite img→asset) → đi cùng zip, v0.5.
- set_access / unpublish qua MCP → v0.5.
- unorphan / relocate annotation qua MCP → v0.5 (v0 người làm trên UI).
- moderate / delete_document / reactions qua MCP → v0.5+.
- n8n integration → v2.
- stdio transport → không làm.

## Gaps

- GAP-001 (status: resolved → C-006, AS-003): doc agent tạo mặc định **restricted**
  (riêng token-owner; share sau bằng tay/UI). (Chốt 2026-06-07.)
- GAP-002 (status: resolved → AS-003 + workspace-project:C-009): mỗi tài khoản có một
  default project tự tạo; MCP đưa doc vào đó nếu thiếu projectId. (Chốt 2026-06-07.)
- GAP-003 (status: deferred): chuẩn hoá payload suggestion để agent áp đáng tin
  (from/to + block_id + offset). Couples `annotation-core`. Source: "Suggestion
  payload chuẩn hoá thế nào".
- GAP-004 (status: deferred): ngưỡng rate-limit MCP theo token — chốt lúc build.
  Source: "Rate-limit MCP cho token".
- GAP-005 (status: open) [/mf-challenge H-idempotency]: create/update qua MCP cần
  idempotency key (dedupe theo token+doc) + serialize tạo version per-doc (advisory
  lock) để retry HTTP không tạo doc/version trùng và không double-trigger re-anchor.
  Gated cùng C1 (re-anchor). Source: /mf-challenge failure-mode.

## Clarifications — 2026-06-07

- **API token thay vì OAuth ở v0:** agent chạy local/CI, token header là cách
  self-host đơn giản nhất.
- **Streamable HTTP:** instance đã là server; agent remote/CI cần HTTP; stdio giới hạn.
- **Full round-trip (gồm reply/resolve):** vòng "agent sửa rồi đánh dấu đã xử" mới
  thật sự khép.
- **create trả slug + update append version:** khớp model danh tính chốt ở
  render-publish/versioning.
- **since-cursor cho pull:** để agent không xử lại annotation đã xử.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/mcp-roundtrip.md) | -- |
| 2026-06-07 | GAP-001 resolved → C-006 (agent doc = restricted) | -- |
| 2026-06-07 | GAP-002 resolved → AS-003 + workspace-project:C-009 (default project per user) | -- |
| 2026-06-07 | /mf-challenge harden H4: C-008 + AS-010 (token hashed/scope/revoke, pull per-doc authZ); GAP-005 idempotency | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
