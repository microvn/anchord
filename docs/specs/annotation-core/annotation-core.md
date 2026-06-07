# Spec: annotation-core

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

Chọn vùng text (HTML/Markdown) hoặc vùng ảnh trên doc đã render → để lại comment ở
cột lề phải; thread reply phẳng, resolve/reopen, suggestion. Anchor neo theo block
(bền qua version, tự giải duplicate-quote); khi version mới ra đời, annotation
re-anchor, không khớp thì vào danh sách detached. Trái tim sản phẩm.

_Ships cùng `versioning-diff` (sibling): cụm kia định nghĩa **trigger** version mới;
cụm này định nghĩa **thuật toán** matching + model annotation. Xem `## Linked Fields`._

## Data Model

- **annotations** (neo vào **doc**, không vào version): `id`, `doc_id`, `type`
  (range | multi_range | block | doc), `anchor` (jsonb: `block_id`, `text_snippet`,
  `offset`, `length`, `segments[]`), `is_orphaned` (bool), `status` (unresolved |
  resolved), `created_at`.
- **comments**: `id`, `annotation_id`, `parent_id` (1 tầng, flat), `author_id`
  (nullable), `guest_name` (nullable), `body`, `created_at`.
- Content serve qua content-route (`render-publish`) được inject `data-block-id`
  ổn định cho block element; viewer HTML chạy bridge inject (postMessage).

## Stories

### S-001: Create a text annotation (P0)

**Description:** Là người có quyền comment, tôi bôi đen một đoạn text trên doc và
để lại comment; comment hiện ở cột lề, neo vào đoạn đó theo block.
**Source:** docs/explore/annotation-core.md#quyết-định (mục 1 model, mục 2 transport).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (dự kiến reuse bridge Plannotator + `src/anchor/*` + margin UI)
- `autonomous:` true
- `verify:` bôi đen 1 câu trong doc HTML → ô comment hiện ở cột lề; lưu → mark vàng trên text + thread.

**Acceptance Scenarios:**

AS-001: Tạo annotation text trên doc HTML (viewer sandbox)
- **Given:** người nhận quyền commenter mở doc HTML render trong viewer
- **When:** bôi đen một câu rồi nhập comment và lưu
- **Then:** tạo annotation neo theo block (block_id + text_snippet + offset/length);
  mark highlight hiện trên text; thread hiện ở cột lề thẳng hàng
- **Data:** câu "Thanh toán hết hạn sau 24h" trong block thứ 7

AS-002: Tạo annotation text trên doc Markdown (render app)
- **Given:** người nhận mở doc Markdown render trong app
- **When:** bôi đen một đoạn và comment
- **Then:** tạo annotation neo theo block tương tự; mark + thread hiện
- **Data:** đoạn trong danh sách bullet

AS-003: Quote trùng ở hai block neo đúng block được chọn
- **Given:** doc có cùng cụm từ "see below" xuất hiện ở hai block khác nhau
- **When:** người dùng bôi đen cụm đó ở block thứ hai
- **Then:** annotation neo vào block thứ hai (theo block_id), không nhầm sang block đầu
- **Data:** "see below" ở block 3 và block 9; chọn ở block 9

AS-004: Selection rỗng/chỉ whitespace bị bỏ qua
- **Given:** người dùng đang xem doc
- **When:** "bôi đen" mà không chọn ký tự thực (rỗng/whitespace)
- **Then:** không tạo annotation, không hiện ô comment
- **Data:** selection 0 ký tự

AS-020: postMessage giả mạo từ body doc không tạo annotation [harden C2]
- **Given:** doc HTML không tin cậy chứa script tự gọi `parent.postMessage({...annotation...})`
- **When:** render trong iframe sandbox và script chạy
- **Then:** parent bỏ qua (chỉ nhận qua kênh bridge tin cậy + re-authorize server-side);
  KHÔNG tạo annotation từ message giả mạo
- **Data:** `<script>parent.postMessage(...)</script>` trong body

AS-021: Người không có quyền doc không đọc được annotation [harden H2]
- **Given:** doc restricted, người X không được mời
- **When:** X cố đọc annotation/comment của doc (qua UI hoặc API)
- **Then:** từ chối; không trả nội dung annotation/comment
- **Data:** X ngoài quyền doc

### S-002: Create an image-region annotation (P0)

**Description:** Là người có quyền comment, tôi đánh dấu một điểm hoặc một vùng trên
ảnh và để lại comment; dấu bám đúng vị trí trên ảnh gốc.
**Source:** docs/explore/annotation-core.md#quyết-định (mục 4 image-region).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (dự kiến image annotation layer trên viewer ảnh của render-publish)
- `autonomous:` true

**Acceptance Scenarios:**

AS-005: Pin một điểm trên ảnh (click)
- **Given:** người nhận mở doc ảnh
- **When:** click vào một điểm trên ảnh và comment
- **Then:** tạo annotation type image-region (point) lưu toạ độ normalized 0..1 theo
  ảnh gốc; pin + thread hiện
- **Data:** click tại ~ (0.4, 0.6)

AS-006: Khoanh một vùng trên ảnh (drag)
- **Given:** người nhận mở doc ảnh
- **When:** kéo tạo một hình chữ nhật và comment
- **Then:** tạo annotation image-region (box) lưu toạ độ normalized; vùng + thread hiện
- **Data:** box (0.1,0.1)–(0.5,0.4)

AS-007: Dấu bám đúng vị trí khi zoom/đổi kích thước
- **Given:** một annotation pin đã tạo trên ảnh
- **When:** người dùng zoom in/out hoặc mở trên màn hình kích thước khác
- **Then:** pin vẫn nằm đúng điểm trên ảnh gốc (toạ độ normalized không trôi)
- **Data:** zoom 200% rồi 50%

### S-003: Reply in a thread (P1)

**Description:** Là người trong cuộc, tôi trả lời một comment; reply hiện phẳng dưới
annotation đó.
**Source:** docs/explore/annotation-core.md#quyết-định (mục 5 threading flat).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-008: Reply phẳng dưới annotation
- **Given:** một annotation đã có comment đầu
- **When:** người khác bấm Reply và nhập nội dung
- **Then:** reply hiện phẳng dưới annotation (một tầng, không lồng sâu)
- **Data:** comment gốc + 1 reply

### S-004: Resolve / reopen an annotation (P1)

**Description:** Là người có quyền comment, tôi đánh dấu một annotation là đã xử lý
hoặc mở lại.
**Source:** docs/explore/annotation-core.md#quyết-định (mục 6 resolve).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Resolve rồi reopen
- **Given:** một annotation đang unresolved
- **When:** người dùng bấm resolve, sau đó reopen
- **Then:** status đổi resolved (mark mờ đi) rồi quay lại unresolved
- **Data:** toggle hai lần

AS-010: Người có quyền comment đều resolve được
- **Given:** một annotation tạo bởi người A; người B có quyền commenter
- **When:** người B bấm resolve
- **Then:** annotation chuyển resolved (không chỉ người tạo mới resolve được)
- **Data:** B ≠ tác giả annotation

### S-005: Re-anchor across versions (P0)

**Description:** Khi một version mới được tạo (từ `versioning-diff`), annotation của
version trước được neo lại vào nội dung mới; khớp thì theo sang, không khớp thì vào
danh sách detached.
**Source:** docs/explore/annotation-core.md#quyết-định (mục 1 re-anchor), #unhappy-paths.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (matcher block_id → snippet exact → fuzzy)
- `autonomous:` true

**Acceptance Scenarios:**

AS-011: Khớp chính xác → theo sang version mới
- **Given:** annotation neo ở block_id "block-7" với text_snippet còn nguyên ở
  version mới
- **When:** version mới được tạo
- **Then:** annotation neo lại đúng vị trí trong block-7 ở version mới
- **Data:** block-7 không đổi nội dung

AS-012: Khớp fuzzy khi text đổi nhẹ → vẫn theo sang
- **Given:** block-7 còn tồn tại nhưng text_snippet đổi nhẹ ("24h" → "48 giờ")
- **When:** version mới được tạo
- **Then:** matcher fuzzy trong block-7 vẫn neo được; annotation hiện trên version mới
- **Data:** thay đổi nhỏ trong cùng block

AS-013: Mất block → annotation thành detached
- **Given:** block-7 bị xoá hẳn ở version mới
- **When:** version mới được tạo
- **Then:** annotation đánh `is_orphaned`, vào danh sách "detached" để relocate/resolve;
  không bị mất
- **Data:** block-7 không còn ở version mới

AS-018: multi_range mất một segment → cả annotation detached
- **Given:** một annotation type multi_range bắc qua block-3 và block-9
- **When:** version mới xoá hẳn block-9 (block-3 còn khớp)
- **Then:** cả annotation đánh `is_orphaned`, vào detached (không neo nửa vời chỉ
  phần còn khớp)
- **Data:** 1/2 segment mất block

### S-006: Suggestion annotation (P1)

**Description:** Là người review, tôi tạo một suggestion (xoá / thay thế) lên một
đoạn; nó là annotation có loại đề xuất, không tự sửa nội dung doc.
**Source:** docs/explore/annotation-core.md#quyết-định (mục 7 suggestion).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-014: Tạo suggestion thay thế
- **Given:** người review chọn một đoạn text
- **When:** chọn "suggest replace" và nhập nội dung thay thế
- **Then:** tạo annotation loại suggestion (replace, from→to) với status mặc định;
  nội dung doc KHÔNG đổi
- **Data:** replace "24h" → "48h"

AS-015: Accept/reject chỉ đổi status, không tự sửa content
- **Given:** một suggestion đang chờ
- **When:** tác giả bấm accept (hoặc reject)
- **Then:** status suggestion đổi accepted/rejected; nội dung doc vẫn nguyên (việc
  áp thay đổi do agent làm qua MCP rồi republish — `mcp-roundtrip`)
- **Data:** accept một suggestion replace

AS-022: Suggestion stale khi `from` không còn khớp [harden H5]
- **Given:** suggestion "replace 24h→48h" pin against_version 3; tác giả republish v4
  trong đó "24h" đã bị viết lại
- **When:** accept (hoặc agent áp qua MCP)
- **Then:** verify `from`="24h" không còn khớp tại anchor → đánh `stale`, KHÔNG
  auto-apply; hiển thị khác pending
- **Data:** v4 không còn "24h"

### S-007: Guest commenting (P1)

**Description:** Là người mở link không có account, tôi xem với một tên ngẫu nhiên;
khi comment tôi nhập tên (và email tuỳ chọn).
**Source:** docs/explore/annotation-core.md#quyết-định (mục 8 guest), sharing-permissions.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-016: Người ẩn danh được gán tên ngẫu nhiên
- **Given:** doc bật anyone-with-link + guest commenting
- **When:** người không đăng nhập mở link
- **Then:** được gán tên ngẫu nhiên (vd "Mèo Ẩn Danh") cho phiên xem
- **Data:** không có account

AS-017: Guest comment với tên + email tuỳ chọn
- **Given:** người ẩn danh muốn comment
- **When:** bôi đen text, nhập tên "Lan" + email tuỳ chọn rồi gửi
- **Then:** comment lưu với `guest_name` "Lan" (author_id rỗng)
- **Data:** tên "Lan", email optional

AS-019: HTML trong comment body / guest_name render trơ [harden C3]
- **Given:** một guest gửi comment body hoặc guest_name chứa HTML/script
- **When:** owner mở doc, thread render ở app origin
- **Then:** nội dung render escaped/sanitize, script KHÔNG chạy; guest_name quá dài bị cắt
- **Data:** body = `<img src=x onerror=...>`, guest_name dài bất thường

## Constraints & Invariants

- C-001: Anchor block-scoped — `block_id` là **positional hint** (`block-{tag}-{n}`,
  inject server-side lúc serve/publish, counter tuần tự theo loại tag; element có sẵn
  id → thêm `data-block-id`); `text_snippet` chỉ cần unique trong block, neo theo
  block_id; tự giải duplicate-quote. Độ bền qua version KHÔNG dựa block_id ổn định mà
  dựa text_snippet+offset+fuzzy+orphan (C-002). (AS-001, AS-003)
- C-002: Re-anchor khi version mới: block_id → snippet exact → fuzzy → không thấy =
  `is_orphaned` (detached); không bao giờ mất annotation. multi_range mất bất kỳ
  segment nào → cả annotation detached (không neo nửa vời). (AS-011, AS-012, AS-013, AS-018)
- C-003: Suggestion KHÔNG bao giờ tự sửa content; chỉ đổi status; áp thay đổi qua
  MCP round-trip. (AS-014, AS-015)
- C-004: Thread phẳng một tầng (reply dưới annotation, không lồng sâu). (AS-008)
- C-005: Resolve là toggle; ai có quyền comment trở lên đều resolve/reopen được. (AS-009, AS-010)
- C-006: Image-region lưu toạ độ normalized 0..1 theo ảnh gốc, bền khi zoom/đổi màn hình. (AS-005, AS-006, AS-007)
- C-007: Anon viewer được gán tên ngẫu nhiên; guest comment bắt buộc có tên. (AS-016, AS-017)
- C-008 [harden C3]: comment `body` và `guest_name` là untrusted; render escaped/sanitize
  (dompurify hoặc plaintext-only) ở app origin; `guest_name` giới hạn độ dài + charset.
  HTML trong body/tên render trơ. (AS-019)
- C-009 [harden C2]: bridge do app phục vụ (KHÔNG nằm trong body không tin cậy), chạy
  qua kênh riêng (MessageChannel/nonce), KHÔNG validate bằng origin (opaque="null").
  Mọi message từ iframe là *hint* untrusted; parent re-authorize việc ghi annotation
  server-side theo role phiên. postMessage giả mạo từ body doc KHÔNG tạo annotation. (AS-020)
- C-010 [harden H2]: đọc annotation/comment được authorize theo role hiệu lực của
  người đọc trên doc cha; người không có quyền doc không đọc được annotation của nó. (AS-021)
- C-011 [harden H5]: suggestion pin `against_version` + exact `from` span; lúc accept
  (và lúc agent áp qua MCP) verify `from` còn khớp tại anchor, không khớp → đánh
  `stale`, KHÔNG auto-apply; stale hiển thị khác pending. (AS-022)
- C-012 [harden H1/M1, gated by C1]: KHI re-anchor được chốt (xem GAP-002), nó phải:
  chạy async (không gate publish), idempotent theo `(annotation_id, version_id)`
  (ledger, không mutate `anchor` in-place), phát summary mỗi publish (carried/fuzzy/
  detached) + alert khi tỉ lệ detached vượt ngưỡng (vd >25%). (GAP-002)

## Linked Fields

- **"version mới được tạo" (event)** — produced by `versioning-diff:S-001/S-003`.
  Consumed by annotation-core:S-005 (AS-011/012/013) để chạy re-resolve. ✔ producer
  có AS tạo version ở cả update lẫn restore.
- **anchor descriptor + kết quả matching (carry | orphaned)** — produced by
  annotation-core (Data Model + S-005). Consumed by `versioning-diff:S-005`
  (AS-009/010) để hiển thị carry-forward + detached list. ✔ model + thuật toán định
  nghĩa ở đây; sibling tiêu thụ kết quả.

## UI Notes

Từ `docs/explore/annotation-core.md` §UI sketches. Greenfield → tất cả `[N]`. Component
names only. Dark-operator (`DESIGN.md`), chrome lùi sau doc+comment. Precedence: AS > Tree.

- `DocViewer` `[N]` *(3-pane; là màn cốt lõi, chrome dùng chung với render-publish)*
  - `ViewerTopBar`: title · `LiveBadge` · `FormatBadge` · versionLabel · undo/redo · `PreviewEditToggle` · `CommentsButton` · `ShareButton` · `ThemeToggle` · `OverflowMenu`
  - `SpecMetaStrip` *(chỉ doc dạng spec: tags · stories · AS · Draft · url)*
  - `TocSidebar` *(collapsible)*
    - `TocSearch`
    - `NavGroup` → `NavItem` *(scroll-spy active; `PriorityBadge` P0/P1/P2 nếu là spec)*
  - `DocPane`
    - `DocModeToolbar`: Select·Markup · Wide·Focus
    - `DocTitle` *(Fraunces)* + rendered content (qua DocRenderFrame)
    - `SelectionPopover` *(nổi trên đoạn bôi đen)*: comment · suggest · resolve · react · dismiss
    - `AnnotationHighlight` *(mark trên text; trạng thái active/resolved)*
  - `AnnotationsRail`
    - `RailHeader` *(count)*
    - `CommentThread`: `QuoteRef` · `Avatar` · name · time · body · `ReplyList` *(flat, 1 tầng)* · badge (`SuggestBadge`/`ResolvedBadge`)
    - `DetachedSection` *(amber; annotation `is_orphaned`)*
    - `Composer`: textarea · `GuestNameField` *(khi guest)* · sendButton
  - *Mobile (<600): `TocSidebar` + `AnnotationsRail` → drawer/bottom-sheet; `CommentFab` (count) mở rail; tap highlight mở thread.*
- `ImageRegionLayer` `[N]` *(trên ImageViewer)*: `RegionPin` *(click=point)* · `RegionBox` *(drag)* — toạ độ normalized 0..1

## What Already Exists

### System Impact & Technical Risks

- Repo greenfield. Reuse hợp pháp: Plannotator `html-viewer` (bridge-script /
  postMessage / mark rendering, MIT/Apache) — reuse transport, THAY matcher
  exact-substring bằng block-scoped + fuzzy. uselink: chỉ học model (block anchor,
  orphan/unorphan), không lấy code.
- Schema đổi so với bản phác cũ: `annotations` neo vào **doc** (không vào version) +
  cột `anchor jsonb` (block model) + `is_orphaned` + `status`.
- Risk (high): bridge cross-origin + block_id engine + re-anchor fuzzy + ràng buộc
  hai chiều với `versioning-diff`. Là nơi quyết định sản phẩm sống/chết.

## Not in Scope

- Trigger tạo version + diff + restore — `versioning-diff`.
- Bật/tắt guest commenting, role quyết định ai comment/moderate — `sharing-permissions`.
- Pull annotations / áp suggestion / reply-resolve qua agent — `mcp-roundtrip`.
- Reply lồng nhiều tầng — v0 flat.
- Reactions/emoji trên comment — v0.5.
- Auto-apply suggestion vào content — không làm (mô hình bất biến).
- Real-time presence / con trỏ người khác — v2.
- Moderation nâng cao (xoá bất kỳ) — v0.5; v0 chỉ owner/editor (cụm sharing).

## Gaps

- GAP-001 (status: open): ngưỡng fuzzy trong block — bao nhiêu thì coi khớp vs
  orphan (cân nhắc diff-match-patch). Source: "ngưỡng 'fuzziness' bao nhiêu".
- GAP-002 (status: RESOLVED → C-001, qua điều tra uselink 2026-06-07): block_id =
  **positional, inject server-side lúc publish**. Bằng chứng: so `draft_content` vs
  `published_content` của doc uselink thật — published thêm `id="block-{tag}-{n}"`
  (counter tuần tự theo từng loại tag, theo thứ tự DOM; element đã có id thì thêm
  `data-block-id`). block_id KHÔNG phải identity ổn định cỡ CRDT (reviewer C1 framing
  sai); nó là **hint rẻ**, độ bền đến từ text_snippet+offset+fuzzy+orphan. → re-anchor
  GIỮ trong v0, S-005 unblock. Còn lại chỉ là ngưỡng fuzzy (GAP-001).
- GAP-003 (status: resolved → AS-018): `multi_range` mất bất kỳ segment nào → cả
  annotation detached (không neo nửa vời). (Quyết định 2026-06-07.)
- GAP-004 (status: deferred): công adapt `HtmlBlock`/`useHtmlAnnotation` Plannotator
  (giả định srcdoc) sang src+content-route — đo lúc build. Source: "Reuse HtmlBlock
  … cần adapt … bao nhiêu công".

## Clarifications — 2026-06-07

- **Anchor block-scoped (uselink) thay vì nodePath/indexOf toàn doc (Plannotator
  nguyên si):** bền qua version + tự giải duplicate-quote; model production đã chứng
  minh.
- **Reuse bridge Plannotator nhưng thay matcher:** lấy phần UI khó (select→mark→
  margin) mà vẫn đạt độ bền anchord cần.
- **Suggestion không auto-edit:** content nguồn ở file tác giả + version bất biến;
  áp text-edit lên HTML đáng tin rất khó; round-trip MCP đúng tinh thần "agent kéo
  feedback về sửa".
- **Thread flat:** cột lề hẹp, lồng sâu khó đọc; Google Docs cũng flat.
- **doc-level annotation:** feedback theo doc, re-resolve mỗi version (chốt chung
  với versioning-diff).
- **multi_range orphan = all-or-nothing:** mất bất kỳ segment nào → cả annotation
  detached, tránh hiển thị nửa vời (chọn an toàn/đơn giản hơn neo phần còn khớp).
- **block_id = positional hint (xác nhận từ uselink):** so draft vs published_content
  của uselink cho thấy block_id là `block-{tag}-{n}` inject lúc publish, KHÔNG ổn định
  qua chỉnh sửa. Độ bền re-anchor đến từ text_snippet+fuzzy+orphan. Bác bỏ lo ngại
  /mf-challenge C1 "cần identity cỡ CRDT" — không cần. block_id implement tầm thường.

## Spec Sizing Notes

Stories=7 (đúng soft target). AS=22 (trên soft target 20, trong khoảng overage ≤30).

Overage do hardening từ /mf-challenge (không phải bloat — mỗi AS một atom an toàn):
- AS-019 (XSS render trơ), AS-020 (postMessage giả mạo), AS-021 (read-authZ),
  AS-022 (suggestion stale) — bốn AS bảo mật, mỗi cái một atom riêng.
Hard cap 30 chưa chạm. Nếu re-anchor (S-005) bị defer xuống v0.5 (đang park), AS
giảm lại dưới 20.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/annotation-core.md) | -- |
| 2026-06-07 | GAP-003 resolved → AS-018 (multi_range all-or-nothing detach) | -- |
| 2026-06-07 | /mf-challenge harden: C-008..C-012 + AS-019..022 (XSS, postMessage trust, read-authZ, suggestion stale, re-anchor robustness); GAP-002 → Critical, S-005 parked | -- |
| 2026-06-07 | GAP-002 RESOLVED qua điều tra uselink (draft vs published_content): block_id = positional `block-{tag}-{n}` inject lúc publish; S-005 unblock, re-anchor giữ v0 | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
