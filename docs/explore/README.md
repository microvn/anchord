# anchord — Explore docs (v0)

_2026-06-07_

Khám phá theo cụm cho v0 anchord. Nguồn: design doc
`~/.gstack/projects/claude/administrator-design-20260607-self-hosted-annotation.md`
§4, và đọc source thật (Plannotator OSS, uselink bundle). Stack: Bun + ElysiaJS +
Drizzle + Postgres (xem `CLAUDE.md`).

## 8 cụm v0

| Cụm | File | Quyết định cốt lõi |
|---|---|---|
| render-publish | [render-publish.md](render-publish.md) | iframe `src` + CSP sandbox; MD app-styled / HTML sandbox; slug bất biến + append version; ảnh zoom/pan; cap 5MB/25MB |
| versioning-diff | [versioning-diff.md](versioning-diff.md) | content tạo version; restore=append-copy; **re-anchor + detached**; diff two-level (source + rendered side-by-side) |
| annotation-core | [annotation-core.md](annotation-core.md) | anchor **block-scoped** (uselink) + bridge Plannotator + fuzzy; doc-level; image-region toạ độ; thread flat; suggestion=typed+MCP |
| sharing-permissions | [sharing-permissions.md](sharing-permissions.md) | Google-Docs: 4 role, 3 general-access, anon view + tên ngẫu nhiên, link password/expiry/view-limit, pending invite |
| auth | [auth.md](auth.md) | better-auth; email+pw + GitHub + Google (v0); auto-link nếu verified; DB session |
| workspace-project | [workspace-project.md](workspace-project.md) | single workspace=instance; member tạo project/doc; browse theo doc-access; search title+content+comment; notify in-app+email |
| mcp-roundtrip | [mcp-roundtrip.md](mcp-roundtrip.md) | API token + Streamable HTTP; create/update/read/search + pull_annotations + reply/resolve |
| self-host | [self-host.md](self-host.md) | content Postgres + ảnh volume; SMTP optional+degrade; no telemetry; single-binary v1 (đã pha loãng) |

**UI sketches:** ASCII mỗi màn nằm trong `## UI sketches` của từng explore doc (đúng
quy ước /mf-explore, để /mf-plan route [N]/[E]/[X]) — greenfield nên tất cả `[N]`.
Bản đồ màn↔cụm: render-publish (New doc + render) · annotation-core (viewer + image
+ mobile) · versioning-diff (history+diff) · sharing-permissions (share dialog) ·
auth (sign-in + first-run) · workspace-project (browser+search + notifications) ·
mcp-roundtrip (settings token) · self-host (không UI riêng). Design system:
`DESIGN.md` (repo root). Lưu ý: self-host ghi SMTP-optional nhưng đã đảo thành
**SMTP bắt buộc** (xem auth C-008 / self-host spec).

## Quyết định xuyên suốt (đọc trước khi /mf-plan)

- **Model danh tính doc:** slug bất biến (create) + append immutable version
  (update). Visibility KHÔNG ở publish — thuộc sharing (general-access).
- **Anchor:** block-scoped `{ type, block_id, text_snippet, offset, length,
  segments }`, doc-level, `is_orphaned`. Re-anchor khi version mới: block_id →
  snippet exact → fuzzy → detached. **annotation-core ↔ versioning-diff ràng buộc
  hai chiều — /mf-plan nên chốt cùng nhau.**
  - **block_id = positional hint** (`block-{tag}-{n}`, inject server-side lúc
    publish) — xác nhận qua điều tra uselink (so draft vs published_content). KHÔNG
    phải identity ổn định; độ bền dựa text_snippet+fuzzy+orphan. (Đóng /mf-challenge C1.)
- **Render:** HTML không tin cậy chạy trong iframe sandbox (opaque origin, no
  same-origin) qua content-route + CSP `sandbox` header. dompurify CHỈ cho nội
  dung render ở app origin (MD, comment) — KHÔNG cho HTML sandbox.
- **Reuse hợp pháp:** Plannotator `html-viewer` (bridge/postMessage/mark, MIT/
  Apache) — reuse transport, THAY matcher exact-substring bằng block-scoped+fuzzy.
  uselink: chỉ học model (block anchor, orphan/unorphan), không lấy code.
- **better-auth tự quản schema auth** (`user/session/account/verification`) → bảng
  `users` phác ban đầu nhường cho nó; bảng app tham chiếu `user.id`.

## Cần đồng bộ (tài liệu đang vênh)

- **SQLite → Postgres:** design doc §4.8/§5/§6 vẫn ghi SQLite; đã đổi sang
  Postgres (workload multi-writer). `CLAUDE.md` đã theo Postgres. Khi /mf-plan nên
  sửa design doc cho khớp.
- **Single-binary:** giấc mơ "một file" của design doc dựa trên SQLite; với Postgres
  v1 single-binary = binary app + Postgres kèm, không all-in-one.
- **mf-stack schema:** design doc đánh ⭐ v0; theo chỉ đạo đã **bỏ khỏi v0** (coi
  doc mf-stack như HTML/MD thường).

## Schema đổi so với bản phác `src/db/schema.ts` (đã revert)

- `annotations`: bỏ neo `docVersionId`, đổi sang neo **doc** + cột `anchor jsonb`
  (block model) + `is_orphaned` + `status`.
- `docs`: thêm `slug` bất biến.
- `users`: nhường cho better-auth.
- Thêm: `doc_shares`/`doc_members`, `share_links`, `api_tokens`, `notifications`,
  FTS index (title+content+comment), blob dedup theo content_hash.

## Bước kế

Mỗi cụm → `/mf-plan` thành spec có acceptance scenarios, rồi `/mf-build`.
Thứ tự đề xuất: render-publish → versioning-diff + annotation-core (cùng nhau, do
ràng buộc re-anchor) → auth → sharing-permissions → workspace-project →
mcp-roundtrip → self-host.
