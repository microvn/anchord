## Explore: render-publish

_2026-06-07_

**Feature:** Nhận artifact (HTML / Markdown / ảnh) qua nhiều đường, lưu thành doc
có slug bất biến + version bất biến, render an toàn mà vẫn "chạy thật" để người
nhận đọc qua một link.

**Trigger:** Tác giả chủ động — upload file / paste / agent gọi MCP. Không có
trigger tự động (cron/webhook) ở v0.

**UI expectation:** Màn "New doc" đơn giản: vùng upload/paste, ô title (auto-suy,
sửa được), nút Publish. Trang xem doc = layout 2 cột (nội dung trái + cột lề phải
để dành cho annotation cụm sau). Toàn bộ UI là **[N] NEW** — repo greenfield,
chưa có gì.

---

### Quyết định kiến trúc (đã chốt trong phiên explore)

**1. Render mode — iframe src + CSP sandbox.**
Mỗi version được serve qua content route (`/v/:id/index.html`), render bằng
`<iframe src=... sandbox="allow-scripts">` (KHÔNG `allow-same-origin`). Endpoint
trả kèm header `Content-Security-Policy: sandbox allow-scripts` để ép opaque
origin kể cả khi mở thẳng URL top-level (defense-in-depth).

- JS trong HTML do AI tạo **chạy thật** (chart/tab/toggle sống) nhưng opaque
  origin → không đọc được cookie/DOM/localStorage của app.
- Hệ quả: **render trong sandbox KHÔNG cần dompurify.** dompurify chỉ áp cho thứ
  render trong origin tin cậy của app (body comment, title, preview). → Cần sửa
  CLAUDE.md: câu "mọi AI HTML qua dompurify" phải nói rõ "trừ nội dung render
  trong sandbox iframe".
- Không dùng `srcdoc` làm đường chính, không dùng origin/subdomain riêng — giữ
  self-host một origin.

**2. Markdown định tuyến theo format.**
- MD thuần → render trong app origin + dompurify (đẹp theo theme app, deep-link),
  **không chạy JS**.
- Cần JS/interactive thật → tác giả publish dạng **HTML**, đi đường sandbox.
- Người dùng có "cả hai" ở mức chọn format khi publish, không trộn trong 1 file.
  Kiểu "island" (nhúng khối raw-HTML/JS trong iframe lồng) **defer v2**.

**3. Mô hình danh tính + version (theo uselink, điều chỉnh cho anchord).**
- `create` → tạo doc với **slug bất biến** + version 1.
- Mỗi lần push content mới → **append version bất biến mới** (không ghi đè).
  Ngữ nghĩa version/diff/restore đầy đủ thuộc cụm **versioning-diff**.
- render-publish **không** lo "ai xem được" — đó là cụm **sharing-permissions**
  (general-access). Không có toggle publish/unpublish riêng; "unpublish" ≈ set
  general-access về restricted.
- Tham chiếu: uselink tách create/update/publish/unpublish; anchord gộp visibility
  vào sharing để khỏi nhân đôi khái niệm.

**4. Ảnh là artifact, có zoom/pan.**
- Hiển thị ảnh với zoom in/out + pan. Pin comment (cụm annotation) neo theo **toạ
  độ ảnh gốc** (normalized), bền khi zoom/đổi kích thước màn hình.
- Raster (PNG/JPG/WebP/GIF) → thẻ `<img>`. SVG → render trong iframe sandbox (có
  thể chứa script).

**5. Title auto-suy + sửa được.**
- HTML: `<title>` → fallback H1 đầu. MD: H1 đầu. Ảnh: tên file.
- Luôn cho tác giả sửa trước khi publish (kể cả agent truyền title qua MCP).

---

### Happy path

1. Tác giả (đã đăng nhập) mở màn "New doc", upload `spec.html` (1.2MB).
2. Hệ thống suy title từ `<title>` = "Payment Spec v2"; tác giả sửa thành
   "Payment Spec".
3. Bấm Publish → backend lưu artifact, tạo doc (slug bất biến) + version 1, trả
   link `/d/:slug`.
4. Mở link → HTML render sống trong iframe sandbox, JS chạy (tab/chart hoạt
   động). Cột lề phải trống (annotation thuộc cụm sau).

### Unhappy paths

- **Quá cỡ:** upload `dashboard.html` 8MB → vượt cap 5MB → từ chối trước khi lưu,
  báo "File 8.1MB vượt giới hạn 5MB". Không tạo doc.
- **Nội dung hỏng / sai loại:** ảnh corrupt → khung render hiện placeholder "Không
  đọc được ảnh". File đuôi `.md`/`.html` nhưng content-type sniff không khớp →
  báo lỗi, không publish.
- **MCP publish không kèm danh tính doc:** agent gọi `publish` không truyền docId
  → tạo **doc mới**; có docId/slug → append version. (Cross-cluster: ngữ nghĩa đầy
  đủ ở versioning-diff + mcp-roundtrip.)

---

### Business rules

- Cap dung lượng 1 artifact: **HTML/MD 5MB, ảnh 25MB**. Vượt → reject với message
  rõ kích thước thực tế.
- Mỗi publish content mới = một version bất biến mới; không sửa version cũ.
- Slug sinh một lần lúc create, bất biến suốt đời doc.
- Content-type xác định bằng sniff nội dung, không chỉ tin đuôi file.

### Input validation

- File upload: loại cho phép = `.html`, `.md`/`.markdown`, ảnh (png/jpg/webp/gif/svg).
  Loại khác → reject.
- Title: bắt buộc không rỗng sau khi suy/sửa; max 255 ký tự (assumption).
- Paste: nội dung không rỗng; chọn format HTML hay MD (assumption: có toggle khi paste).

### Permissions

- **Được publish:** user đã đăng nhập, là member của workspace (chi tiết role do
  cụm sharing/workspace định). v0 single-workspace.
- **Bị chặn:** khách chưa đăng nhập không publish được. (Khách *xem/comment* là
  việc cụm sharing.)

### Data impact

- Bảng đã phác trong `src/db/schema.ts` (đã revert, sẽ dựng lại khi build):
  `docs` (slug, kind, title) + `doc_versions` (version, content, content_hash).
- Cần thêm: cột `slug` bất biến trên `docs` (schema cũ chưa có) + lưu nơi chứa
  artifact đã serve cho content route. Storage: content nằm trong Postgres
  (`doc_versions.content`); ảnh lớn cân nhắc lưu ngoài (open question).

### Out of scope (v0 — defer)

- **Import .zip** (CSS/font/ảnh đi kèm) → v0.5. Bỏ luôn zip-slip/zip-bomb/entry-point.
- **`<img src>` → asset endpoint rewrite** (kiểu `publish_with_assets`) → đi cùng zip/asset, v0.5.
- **Hiểu schema mf-stack** (S/AS/C/P, ID-as-anchor) → defer. Coi doc mf-stack như
  HTML/MD thường. (Chủ ý của tác giả: đừng nằng nệ mf-stack.)
- **Island** (raw-HTML/JS nhúng trong MD) → v2.
- Annotate PDF, annotate live URL → v2.
- Visibility/sharing, versioning/diff, MCP tool surface → các cụm riêng.

### Decision rationale

- Sandbox iframe thay vì dompurify-strip: vì yêu cầu "HTML chạy thật" mâu thuẫn
  với việc sanitize cắt JS. Cách ly origin giải được cả hai. Nếu sau này thấy
  opaque-origin chưa đủ → chuyển sang origin sandbox riêng (đắt hơn cho self-host).
- iframe `src` thay vì `srcdoc`: ban đầu vì zip cần resolve đường dẫn tương đối;
  zip đã defer nhưng vẫn giữ `src` cho nhất quán + tránh srcdoc cồng kềnh với doc lớn.
- Visibility để cụm sharing thay vì publish/unpublish riêng: tránh hai nơi cùng
  điều khiển hiển thị → giảm bug "đã publish nhưng general-access vẫn restricted".
- Defer mf-stack: tác giả không ưu tiên; tránh phình v0.

### Assumptions (cần xác nhận)

- Paste có toggle chọn HTML/MD.
- Title max 255 ký tự.
- Content (HTML/MD) lưu trong Postgres; ảnh có thể cần lưu filesystem/volume.
- Render fail không làm sập app — iframe lỗi thì hiện trạng thái lỗi trong khung,
  không crash trang.

### Open questions

- `@font-face` cross-origin từ opaque-origin iframe về app cần header CORS (ACAO)
  trên content endpoint — xác nhận khi build.
- Ảnh lớn (tới 25MB) lưu trong Postgres hay filesystem/volume? Ảnh hưởng schema +
  backup story của self-host.
- MCP publish identity: tool nào tạo doc, tool nào append version, key định danh
  là gì (docId vs slug)? → chốt ở cụm **mcp-roundtrip** (tham khảo uselink:
  create_document / update_document / publish_document).
- Content-type sniffing dùng lib nào (file-type) và danh sách MIME chấp nhận chính xác.
- Doc lớn (gần 5MB HTML) render trong iframe có cần lazy/stream không — đo lúc build.

### Complexity signal: **medium**

Sandbox render + CSP đúng cách là phần khó nhất; phần còn lại (lưu version, suy
title, cap size) thẳng. Zip/asset/mf-stack đã cắt ra giúp giảm tải v0.

### Cross-cluster dependencies

- **annotation-core:** cột lề phải, anchor type 2 (image-region) dựa trên toạ độ
  ảnh gốc mà cụm này dựng.
- **versioning-diff:** append version, restore, diff dùng `doc_versions` ở đây.
- **sharing-permissions:** general-access quyết định ai mở được link `/d/:slug`.
- **mcp-roundtrip:** create/update/publish tool map vào model danh tính chốt ở đây.
- **self-host:** quyết định lưu ảnh (Postgres vs volume) ảnh hưởng backup.

## UI sketches

Dark-operator (xem `DESIGN.md`). Greenfield → tất cả `[N]` NEW.

**New doc / Publish** `[N]` ← S-001 (upload/paste/MCP, title auto-suy, cap 5MB/ảnh 25MB)
```
┌───────────────────────────────────────────────┐
│ ⚓ microvn /            New doc            ✕     │
│ [ ⬤ Upload file ][ Paste ][ ⌥ via MCP ]        │
│ ┌ Kéo-thả .html/.md/ảnh   (≤5MB · ảnh ≤25MB) ─┐ │
│ └───────────────────────────────────────────┘ │
│ Format [⬤HTML|Markdown]  Title [ annotation-core ] ← suy <title>/H1, sửa được │
│                              [ Publish ] ⚓     │
└───────────────────────────────────────────────┘
```

**Render trong viewer** `[N]` ← S-002 (HTML iframe sandbox, chạy JS) / S-003 (MD app-render)
/ S-004 (ảnh zoom-pan). Khung viewer + chrome dùng chung với annotation-core (xem UI
sketches ở đó: TOC trái · doc center · rail phải). Render-publish sở hữu *nội dung
render*; annotation-core sở hữu *overlay annotate*.
