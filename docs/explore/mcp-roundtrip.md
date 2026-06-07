## Explore: mcp-roundtrip

_2026-06-07_

**Feature:** MCP server (cùng process backend) cho agent: publish doc, đọc/list/
search, pull annotations về để sửa tiếp, và reply/resolve comment. Khép vòng
agent → người annotate → agent.

**Trigger:** Agent (Claude/Cursor/Codex…) gọi MCP tool qua kết nối tới instance.

**UI expectation:** Không có UI riêng (là server). Có UI nhỏ trong settings để
user tạo/thu hồi **personal API token**. **[N] NEW**.

---

### Tham chiếu đã đọc

- **uselink MCP tools:** read (list/read/search_documents, list_comments,
  list_assets), write (create/update/publish/unpublish/delete_document,
  upload_asset/zip, reply_comment, resolve_comment), orchestrator
  (publish_with_assets — rewrite `<img src>`→CDN). Comments API: list/create/reply/
  moderate/update/delete/**unorphan**, reactions.toggle.
- **better-auth** v1.5 OAuth 2.1 Provider hỗ trợ MCP agent (để v0.5).

---

### Quyết định (đã chốt trong phiên explore)

**1. Agent auth = personal API token (v0).**
- User tạo token trong settings; agent đặt vào config MCP (header). Token mang
  quyền của user đó. OAuth 2.1 (better-auth provider) → v0.5.

**2. Transport = Streamable HTTP.**
- Agent kết nối `https://instance/mcp`. Hợp self-host (instance là server Elysia
  sẵn), agent ở máy khác vẫn dùng được. stdio → không làm v0.

**3. Tool surface v0 (cả 4 nhóm — full round-trip):**

*Publish:*
- `create_document(content, format, title?)` → tạo doc + **slug bất biến** + version
  1, **trả về docId/slug**. (Gỡ open question danh tính doc của render-publish.)
- `update_document(docId, content)` → **append version mới** (không ghi đè). Title
  sửa riêng (metadata mutable).

*Read:*
- `list_documents()` / `read_document(idOrSlug)` / `search_documents(query)` —
  **scope theo quyền của token-owner**.

*Pull annotations (nửa cốt lõi của round-trip):*
- `pull_annotations(docId)` → trả annotation + comment thread + `status`
  (resolved/unresolved, `is_orphaned`) + suggestion (type delete/replace + nội
  dung đề xuất) + `anchor` (block_id, `text_snippet`, offset/length) để agent định
  vị trong source của nó.

*Write back:*
- `reply_comment(commentId, body)` / `resolve_comment(annotationId)` — agent trả
  lời / đánh resolve sau khi xử lý.

**4. Visibility KHÔNG nằm ở MCP publish.**
- create/update chỉ tạo doc + version. "Ai xem được" do cụm sharing (general-access).
  Agent có thể đặt access qua tool riêng → defer v0.5 (hoặc default theo workspace
  default access policy).

---

### Happy path

1. Agent (Claude Code) cầm API token, gọi `create_document(content=spec.html,
   format=html, title="Payment Spec")` → nhận `{ docId, slug, url }`.
2. Người dùng share link, reviewer annotate + suggestion "replace 24h → 48h".
3. Agent gọi `pull_annotations(docId)` → nhận list gồm comment + suggestion
   (type=replace, from="24h", to="48h", text_snippet, block_id).
4. Agent sửa source, gọi `update_document(docId, content=spec-v2.html)` → tạo
   version 2; re-anchor chạy (cụm versioning); agent `resolve_comment` các mục đã
   xử lý + `reply_comment` "đã đổi thành 48h ở v2".

### Unhappy paths

- **Token sai/thu hồi:** MCP từ chối (401), agent nhận lỗi rõ.
- **update_document docId không tồn tại / không có quyền:** từ chối; gợi ý
  create_document nếu muốn doc mới.
- **pull_annotations doc bị orphaned nhiều:** trả kèm cờ `is_orphaned` để agent
  biết comment nào không còn neo chắc (định vị bằng text_snippet best-effort).
- **search trả doc ngoài quyền token:** loại khỏi kết quả.

### Business rules

- create trả slug bất biến; update luôn append version, không sửa version cũ.
- Mọi tool thực thi dưới quyền của user sở hữu token (đúng doc-access của họ).
- Visibility không đổi qua MCP ở v0 (default policy hoặc UI người dùng).

### Input validation

- create: content không rỗng, format ∈ {html, markdown, image}; cap size như
  render-publish (HTML/MD 5MB, ảnh 25MB).
- update: docId hợp lệ + token-owner có quyền editor+ trên doc.
- reply/resolve: commentId/annotationId thuộc doc token-owner truy cập được.

### Permissions

- Token = quyền của user. publish/update cần editor+ trên doc đích (hoặc tạo mới =
  trở thành owner). pull/read theo doc-access. reply/resolve theo quyền comment.

### Data impact

- Bảng `api_tokens` (userId, hashed token, name, lastUsedAt, createdAt, revokedAt).
- MCP tái dùng các bảng doc/version/annotation/comment; không thêm model riêng cho
  nội dung.
- pull_annotations cần join annotation + comment + anchor (block model ở
  annotation-core).

### Out of scope (v0 — defer)

- OAuth 2.1 agent auth (better-auth provider) → v0.5.
- upload_asset / upload_zip / publish_with_assets (rewrite img→asset) → đi cùng
  zip/asset (v0.5).
- set_access / unpublish qua MCP → v0.5.
- unorphan / relocate annotation qua MCP → v0.5 (uselink có; v0 người làm trên UI).
- moderate/delete_document/reactions qua MCP → v0.5+.
- n8n integration → v2.
- stdio transport → không làm.

### Decision rationale

- API token thay vì OAuth ở v0: agent chạy local/CI, token header là cách self-host
  đơn giản nhất, không dựng OAuth flow sớm.
- Streamable HTTP: instance đã là server; agent remote/CI cần HTTP, stdio giới hạn.
- Full round-trip (gồm reply/resolve): user chọn — vòng "agent sửa rồi đánh dấu đã
  xử lý" mới thật sự khép, không chỉ pull một chiều.
- create trả slug + update append version: khớp model danh tính chốt ở
  render-publish/versioning, gỡ dứt open question.

### Assumptions (cần xác nhận)

- Token mang full quyền của user (không scope nhỏ hơn) ở v0.
- pull_annotations trả cả resolved + orphaned (agent tự lọc) kèm đủ context định vị.
- Mỗi user có thể có nhiều token, đặt tên, thu hồi từng cái.

### Open questions

- Default visibility khi agent create (chưa có set_access ở v0): theo workspace
  default access policy? hay restricted rồi user mở tay? → couples sharing/workspace.
- Suggestion payload chuẩn hoá thế nào để agent áp đáng tin (diff-friendly:
  from/to + block_id + offset)? → couples annotation-core.
- Rate-limit MCP cho token (chống abuse trên instance self-host).
- Pull có hỗ trợ "chỉ annotation mới từ lần pull trước" (cursor/since) không, hay
  luôn full? (đề xuất: since-cursor để agent không xử lại).

### Complexity signal: **medium**

MCP SDK + token auth + map tool vào model có sẵn là medium. Phần tinh tế: shape
pull_annotations đủ để agent định vị + áp suggestion, và since-cursor.

### Cross-cluster dependencies

- **render-publish / versioning-diff:** create/update = tạo doc + append version;
  cap size; trigger re-anchor.
- **annotation-core:** pull_annotations shape (anchor block model, suggestion,
  orphaned); reply/resolve.
- **sharing-permissions:** default access cho doc agent tạo; quyền theo token-owner.
- **auth:** token issuance (better-auth user); OAuth 2.1 provider cho v0.5.
- **workspace-project:** doc agent tạo thuộc workspace/project nào (default project?).
- **self-host:** endpoint `/mcp` expose, rate-limit, token storage.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW. Cụm này chủ yếu là API; UI duy
nhất là trang settings token.

**Settings — API token** `[N]` ← S-001 (personal token, hashed/revoke, C-008);
Streamable HTTP; tools create/update/read/search/pull/reply/resolve
```
┌───────────────────────────────────────────────┐
│ Settings › API tokens (cho MCP / agent)        │
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
