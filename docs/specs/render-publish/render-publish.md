# Spec: render-publish

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

Nhận artifact (HTML / Markdown / ảnh) qua upload hoặc paste, lưu thành doc có slug
bất biến + version đầu tiên, và render an toàn cho người nhận đọc qua một link.
HTML "chạy thật" trong sandbox cách ly; Markdown render đẹp theo theme app; ảnh
xem được với zoom/pan. Là cửa vào của anchord — chưa có doc thì chưa annotate được.

_Ships cùng các cụm khác; xem `docs/explore/README.md`. Publish qua MCP nằm ở
`mcp-roundtrip` nhưng tạo cùng artifact (doc+slug+v1) theo model danh tính ở đây._

## Data Model

- **docs**: `id`, `slug` (bất biến, sinh một lần), `kind` (html | markdown | image),
  `title` (mutable metadata), `general_access` (do cụm sharing dùng), timestamps.
- **doc_versions**: `id`, `doc_id`, `version` (int, từ 1), `content` (HTML/MD text;
  ảnh lưu trên volume, xem self-host), `content_hash`, `published_by`, `created_at`.
  Unique (doc_id, version).
- Block-id injection + cột `anchor` cho annotation thuộc cụm `annotation-core`.

## Stories

### S-001: Publish an artifact (P0)

**Description:** Là tác giả đã đăng nhập, tôi upload một file hoặc paste nội dung
để xuất bản nó thành một doc có link chia sẻ, với tiêu đề tự suy mà sửa được.
**Source:** docs/explore/render-publish.md#feature, #happy-path, #quyết-định (mục
3 mô hình danh tính, mục 5 title), #business-rules (cap size, content-type).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (dự kiến `src/routes/publish.*`, `src/services/publish.*`, `src/db/schema`)
- `autonomous:` true
- `verify:` publish một file .html hợp lệ → nhận link, mở link thấy version 1; thử file 8MB → bị từ chối.

**Acceptance Scenarios:**

AS-001: Publish file HTML hợp lệ
- **Given:** tác giả đã đăng nhập, ở màn "New doc"
- **When:** upload `spec.html` (1.2MB), bấm Publish
- **Then:** tạo doc với slug bất biến + version 1; trả về link `/d/:slug`; mở link
  thấy nội dung render
- **Data:** file HTML 1.2MB, có thẻ `<title>Payment Spec v2</title>`

AS-002: Publish bằng paste, chọn format Markdown
- **Given:** tác giả ở màn "New doc", chọn paste + format = Markdown
- **When:** dán nội dung Markdown và Publish
- **Then:** tạo doc kind=markdown + version 1 + link
- **Data:** chuỗi Markdown có H1 "Release Notes"

AS-003: Tiêu đề tự suy và sửa được trước khi publish
- **Given:** đang upload `spec.html` có `<title>Payment Spec v2</title>`
- **When:** ô title được điền sẵn "Payment Spec v2"; tác giả sửa thành "Payment Spec" rồi Publish
- **Then:** doc lưu title "Payment Spec"
- **Data:** title gốc "Payment Spec v2" → sửa "Payment Spec"

AS-004: Artifact vượt giới hạn bị từ chối
- **Given:** tác giả ở màn "New doc"
- **When:** upload `dashboard.html` 8MB
- **Then:** từ chối trước khi lưu với thông báo nêu kích thước thực tế và giới hạn;
  không tạo doc nào
- **Data:** HTML 8.1MB (cap 5MB)

AS-005: Nội dung không khớp loại khai báo bị từ chối
- **Given:** tác giả ở màn "New doc"
- **When:** upload file đuôi `.html` nhưng nội dung sniff ra là binary
- **Then:** từ chối, không publish; báo nội dung không phải HTML/Markdown/ảnh hợp lệ
- **Data:** file `report.html` chứa bytes nhị phân

### S-002: Render HTML live & isolated (P0)

**Description:** Là người nhận, tôi mở doc HTML và thấy nó chạy thật (chart/tab/
toggle hoạt động), trong khi nội dung đó không thể chạm tới phiên đăng nhập hay dữ
liệu của app.
**Source:** docs/explore/render-publish.md#quyết-định (mục 1 render mode), #happy-path.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (dự kiến content-route serve + viewer iframe + CSP header)
- `autonomous:` true
- `verify:` mở doc HTML có tab widget → click tab đổi nội dung; thử script đọc cookie app → không lấy được.

**Acceptance Scenarios:**

AS-006: HTML interactive chạy thật trong viewer
- **Given:** một doc HTML đã publish chứa widget tab dùng JavaScript
- **When:** người nhận mở link và click sang tab khác
- **Then:** nội dung tab đổi (JS chạy thật trong viewer)
- **Data:** HTML có 2 tab + script chuyển tab

AS-007: Nội dung HTML bị cách ly khỏi app
- **Given:** một doc HTML đã publish chứa script cố đọc cookie/đăng nhập của app
- **When:** người nhận mở link
- **Then:** script không đọc được cookie/dữ liệu/giao diện của app (origin cách ly);
  phần còn lại của app không bị ảnh hưởng
- **Data:** HTML có `<script>` cố truy cập storage/cookie của trang cha

AS-008: HTML hỏng cấu trúc vẫn render best-effort
- **Given:** một doc HTML có thẻ không đóng / sai cấu trúc
- **When:** người nhận mở link
- **Then:** viewer vẫn render best-effort, không làm sập trang
- **Data:** HTML thiếu thẻ đóng `</div>`

### S-003: Render Markdown styled (P0)

**Description:** Là người nhận, tôi mở doc Markdown và đọc nó được trình bày đẹp
theo theme app; nội dung script nhúng trong Markdown không chạy.
**Source:** docs/explore/render-publish.md#quyết-định (mục 2 MD routing).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (dự kiến renderer MD + sanitize)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Markdown render theo theme app
- **Given:** một doc Markdown đã publish có heading, danh sách, đoạn văn
- **When:** người nhận mở link
- **Then:** nội dung hiển thị có style theo theme app (không trong iframe)
- **Data:** Markdown có H1/H2 + bullet list

AS-010: Script nhúng trong Markdown không chạy
- **Given:** một doc Markdown chứa khối raw `<script>`
- **When:** người nhận mở link
- **Then:** script bị loại, không thực thi; phần văn bản vẫn hiển thị
- **Data:** Markdown có `<script>alert(1)</script>`

### S-004: View image with zoom/pan (P0)

**Description:** Là người nhận, tôi mở doc ảnh và xem được với zoom/pan, làm nền
cho việc pin comment theo toạ độ về sau.
**Source:** docs/explore/render-publish.md#quyết-định (mục 4 ảnh).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (dự kiến image viewer + zoom/pan)
- `autonomous:` true

**Acceptance Scenarios:**

AS-011: Ảnh hiển thị và zoom/pan được
- **Given:** một doc ảnh PNG đã publish
- **When:** người nhận mở link và zoom in rồi kéo (pan)
- **Then:** ảnh phóng to và di chuyển theo; vị trí dựa trên toạ độ ảnh gốc
- **Data:** PNG 1600×1200

AS-012: Ảnh hỏng hiện placeholder
- **Given:** một doc ảnh có file hỏng/không đọc được
- **When:** người nhận mở link
- **Then:** khung hiện placeholder "Không đọc được ảnh", không sập trang
- **Data:** file ảnh corrupt

AS-013: SVG render cách ly trong sandbox
- **Given:** một doc ảnh SVG chứa script
- **When:** người nhận mở link
- **Then:** SVG render trong iframe sandbox; script không chạm tới app
- **Data:** SVG có phần tử `<script>`

## Constraints & Invariants

- C-001: HTML không tin cậy render trong iframe sandbox opaque origin (không
  `allow-same-origin`) + header `CSP: sandbox allow-scripts`. (AS-007)
- C-002: Nội dung render trong sandbox KHÔNG qua dompurify (giữ JS chạy); nội dung
  render trong app origin (Markdown) PHẢI qua dompurify (cắt JS). (AS-006, AS-010)
- C-003: Cap dung lượng artifact: HTML/MD 5MB, ảnh 25MB; vượt → từ chối, không lưu. (AS-004)
- C-004: Slug sinh một lần lúc tạo doc và bất biến. Tạo doc → version 1. (AS-001)
  _Tính bất biến qua các lần update thuộc cụm versioning-diff._
- C-005: Loại nội dung xác định bằng sniff nội dung, không chỉ tin đuôi file. (AS-005)

## UI Notes

Từ `docs/explore/render-publish.md` §UI sketches. Greenfield → tất cả `[N]`. Component
names only (không markup). Dark-operator theo `DESIGN.md`. Precedence: AS > Tree.

- `NewDocDialog` `[N]`
  - `SourceTabs`: Upload · Paste · viaMCP
  - `UploadDropzone` *(nhận .html/.md/ảnh; cap 5MB / ảnh 25MB → reject message)*
  - `FormatToggle`: HTML · Markdown *(chỉ hỏi khi Paste)*
  - `TitleField` *(auto-suy từ <title>/H1/tên file; editable)*
  - `PublishButton`
- `DocRenderFrame` `[N]` *(nội dung render; chrome quanh — TopBar/TocSidebar/AnnotationsRail — thuộc annotation-core)*
  - `HtmlSandboxFrame` *(iframe sandbox, JS chạy; dùng cho kind=html)*
  - `MarkdownView` *(render app-origin + sanitize; kind=markdown)*
  - `ImageViewer` *(zoom/pan, toạ độ gốc cho image-region; kind=image)*
  - `RenderErrorState` *(ảnh corrupt / sai content-type → placeholder)*

## What Already Exists

### System Impact & Technical Risks

- Repo greenfield — chưa có code. Schema phác cũ trong `src/db/schema.ts` đã revert;
  cần `docs.slug` (bản phác chưa có).
- Reuse: viewer iframe + content-route ở đây được cụm `annotation-core` tái dùng để
  inject bridge + `data-block-id`. Thiết kế content-route nên tính trước hook này.
- Risk: render HTML không tin cậy là bề mặt XSS chính — C-001/C-002 là hàng rào;
  sai sót ở đây là rủi ro bảo mật cao.
- Cross-spec: `mcp-roundtrip` tạo doc/version qua MCP theo cùng model danh tính.

## Not in Scope

- Import `.zip` (CSS/font/ảnh đi kèm) — defer v0.5 (kéo theo zip-slip/zip-bomb/entry-point).
- `<img src>` → asset endpoint rewrite (kiểu publish_with_assets) — đi cùng zip, v0.5.
- Hiểu schema mf-stack (S/AS/C/P, ID-as-anchor) — bỏ khỏi v0 theo chỉ đạo (coi mf-stack như HTML/MD thường).
- "Island" (nhúng raw-HTML/JS trong Markdown) — v2.
- Annotate PDF, annotate live URL — v2.
- Append version / diff / restore — cụm versioning-diff.
- Visibility / general-access enforcement — cụm sharing-permissions.
- Publish qua MCP — cụm mcp-roundtrip (tạo cùng artifact).

## Gaps

- GAP-001 (status: open): `@font-face` cross-origin từ opaque-origin iframe về app
  cần header CORS (ACAO) trên content endpoint — cách cấu hình chưa chốt. Source:
  "@font-face cross-origin … cần header CORS (ACAO)".
- GAP-002 (status: deferred): doc HTML lớn (gần 5MB) có cần lazy/stream khi render
  không — đo lúc build. Owner: build-time perf. Source: "Doc lớn … render trong
  iframe có cần lazy/stream".
- GAP-003 (status: deferred): lib sniffing content-type + danh sách MIME chấp nhận
  chính xác — quyết định lúc build. Source: "Content-type sniffing dùng lib nào".

## Clarifications — 2026-06-07

(Bê từ decision rationale của explore doc; không hỏi lại.)

- **Sandbox iframe thay vì dompurify-strip cho HTML:** yêu cầu "HTML chạy thật" mâu
  thuẫn việc sanitize cắt JS; cách ly origin giải cả hai. Nếu opaque-origin chưa đủ
  → chuyển origin sandbox riêng (đắt hơn cho self-host).
- **iframe `src` + content-route thay vì `srcdoc`:** ban đầu vì zip cần resolve
  đường dẫn tương đối; zip đã defer nhưng giữ `src` cho nhất quán + để
  annotation-core inject `data-block-id`/bridge server-side; tránh srcdoc cồng kềnh.
- **Slug bất biến + append version; visibility tách sang sharing:** tránh hai nơi
  cùng điều khiển hiển thị.
- **Defer zip + mf-stack:** giảm bề mặt v0 theo chỉ đạo.
- **Ảnh lưu trên volume** (quyết định ở cụm self-host), content text trong Postgres.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/render-publish.md) | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
