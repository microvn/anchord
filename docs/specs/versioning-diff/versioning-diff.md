# Spec: versioning-diff

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

Mỗi lần nộp content mới tạo một version bất biến; xem lịch sử, restore version cũ
(append-copy), và so sánh hai version (two-level: source diff + rendered side-by-side).
Là nền cho "anchor bền qua version" — khi version mới ra đời, annotation của version
trước được neo lại.

_Ships cùng `annotation-core` (sibling): cụm này định nghĩa **trigger** re-anchor;
`annotation-core` định nghĩa **thuật toán** matching + model annotation. Xem
`## Linked Fields`._

## Data Model

- **doc_versions** (định nghĩa ở `render-publish`): `version` int từ 1, `content`,
  `content_hash`, `published_by`, `created_at`, unique (doc_id, version).
- Title nằm trên `docs` (mutable), KHÔNG version hoá.
- Annotation neo vào **doc** + descriptor anchor (định nghĩa ở `annotation-core`),
  được re-resolve mỗi version.

## Stories

### S-001: Append a new version on content update (P0)

**Description:** Là tác giả, khi tôi nộp content mới cho một doc, hệ thống tạo một
version bất biến mới thay vì ghi đè, và version mới nhất thành bản hiện hành.
**Source:** docs/explore/versioning-diff.md#quyết-định (mục 1 content tạo version).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (dự kiến `src/services/version.*`, `src/db/schema`)
- `autonomous:` true
- `verify:` nộp content mới cho doc đang ở v2 → xuất hiện v3, current=v3, v2 vẫn còn.

**Acceptance Scenarios:**

AS-001: Nộp content mới tạo version bất biến mới
- **Given:** doc "Payment Spec" đang ở version 2
- **When:** tác giả nộp content đã sửa
- **Then:** tạo version 3 (không ghi đè v2); current = v3
- **Data:** content v3 khác v2

AS-002: Sửa title không tạo version
- **Given:** doc đang ở version 2
- **When:** tác giả đổi title từ "Payment Spec" sang "Payment Spec v2"
- **Then:** title đổi trên doc; KHÔNG tạo version mới (vẫn ở v2)
- **Data:** chỉ đổi title, content giữ nguyên

### S-002: View version history (P1)

**Description:** Là người có quyền xem doc, tôi mở lịch sử và thấy danh sách các
version với thời điểm và người publish.
**Source:** docs/explore/versioning-diff.md#ui-expectation.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-003: Liệt kê lịch sử version
- **Given:** doc có version 1, 2, 3
- **When:** người dùng mở "Version history"
- **Then:** thấy v1, v2, v3 kèm thời điểm tạo và người publish, current đánh dấu rõ

### S-003: Restore a previous version (P0)

**Description:** Là tác giả, tôi restore một version cũ; hệ thống tạo một version
mới copy nội dung version đó, giữ nguyên toàn bộ lịch sử.
**Source:** docs/explore/versioning-diff.md#quyết-định (mục 2 restore append-copy).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true
- `verify:` ở v3, restore v1 → xuất hiện v4 có nội dung = v1; v2,v3 vẫn còn.

**Acceptance Scenarios:**

AS-004: Restore tạo version mới copy nội dung cũ
- **Given:** doc đang ở version 3
- **When:** tác giả bấm "Restore version 1"
- **Then:** tạo version 4 có nội dung bằng version 1; current = v4; v2 và v3 vẫn
  còn trong lịch sử
- **Data:** restore v1 khi đang ở v3

AS-005: Restore kích hoạt re-anchor như mọi version mới
- **Given:** doc ở version 3 có annotation đang neo trên v3
- **When:** tác giả restore v1 (tạo v4)
- **Then:** annotation được re-anchor sang v4 theo cùng cơ chế version mới (xem
  `annotation-core:S-005`)
- **Data:** v4 = nội dung v1, khác v3

### S-004: Compare two versions (P0)

**Description:** Là người có quyền xem doc, tôi chọn hai version bất kỳ để so sánh
và thấy cả khác biệt source lẫn hai bản render đặt cạnh nhau.
**Source:** docs/explore/versioning-diff.md#quyết-định (mục 4 diff two-level).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (dự kiến diff dùng `@pierre/diffs` + rendered side-by-side reuse viewer)
- `autonomous:` true

**Acceptance Scenarios:**

AS-006: Diff two-level cho HTML/Markdown
- **Given:** doc có version 2 và version 3 khác nội dung
- **When:** người dùng chọn "Compare v2 ↔ v3"
- **Then:** hiện khác biệt source (highlight dòng thêm/bớt) + hai bản render đặt
  cạnh nhau (v2 | v3)
- **Data:** v2 và v3 khác vài đoạn text

AS-007: So hai version giống hệt
- **Given:** hai version có nội dung trùng nhau (vd sau restore)
- **When:** người dùng so hai version đó
- **Then:** báo "Không có khác biệt"; vẫn hiện rendered side-by-side
- **Data:** hai version content_hash bằng nhau

AS-008: So hai version của doc ảnh
- **Given:** doc ảnh có hai version
- **When:** người dùng so hai version
- **Then:** hiện hai ảnh đặt cạnh nhau (side-by-side), không diff text
- **Data:** hai ảnh khác nhau

### S-005: Trigger re-anchor on new version (P0)

**Description:** Là người để lại comment, khi tác giả publish version mới, comment
của tôi tự động theo sang nội dung mới nếu còn neo được; nếu không, nó vào danh
sách "detached" thay vì biến mất.
**Source:** docs/explore/versioning-diff.md#quyết-định (mục 3 re-anchor + detached).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (phối hợp với annotation-core)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Annotation khớp được theo sang version mới
- **Given:** doc ở v2 có 6 annotation; tác giả tạo v3 sửa nhẹ vài đoạn
- **When:** version 3 được tạo
- **Then:** các annotation re-resolve được (xem `annotation-core:S-005`) hiển thị
  trên v3
- **Data:** 5/6 đoạn neo còn khớp

AS-010: Annotation không neo được vào danh sách detached
- **Given:** cùng tình huống, 1 đoạn bị xoá hẳn khỏi nội dung
- **When:** version 3 được tạo
- **Then:** annotation đó được đánh `is_orphaned`, đưa vào danh sách "detached" để
  relocate/resolve; không bị mất
- **Data:** 1/6 đoạn biến mất ở v3

## Constraints & Invariants

- C-001: Version bất biến — sau khi tạo không sửa content/hash/người/thời điểm. (AS-001, AS-004)
- C-002: Version đánh số tự tăng liên tục từ 1, không tái dùng số; current = số lớn nhất. (AS-001, AS-003)
- C-003: Chỉ thay đổi content mới tạo version; đổi title/metadata không. (AS-002)
- C-004: Restore không xoá version nào — luôn append. (AS-004)
- C-005: Mỗi khi tạo version mới (gồm restore) → kích hoạt re-anchor cho annotation
  của version trước; không khớp → detached, không mất. (AS-005, AS-009, AS-010)

## Linked Fields

- **"version mới được tạo" (event/trigger)** — produced by versioning-diff:S-001
  (AS-001) và S-003 (AS-004, restore cũng tạo version). Consumed by
  `annotation-core:S-005` để chạy re-resolve. ✔ producer có AS tạo version ở cả
  hai đường (update + restore).
- **anchor descriptor + kết quả matching (carry | orphaned)** — produced by
  `annotation-core` (Data Model + S-005 matching). Consumed by versioning-diff:S-005
  (AS-009/AS-010) để hiển thị carry-forward + detached list. ✔ annotation-core
  định nghĩa model + thuật toán; cụm này chỉ tiêu thụ kết quả.

## UI Notes

Từ `docs/explore/versioning-diff.md` §UI sketches. Greenfield → `[N]`. Component names
only. Dark-operator (`DESIGN.md`). Precedence: AS > Tree.

- `VersionHistoryPanel` `[N]`
  - `VersionList` → `VersionItem` *(versionLabel · time · author · currentMarker)*
  - `RestoreButton` *(append-copy → version mới)*
- `DiffView` `[N]`
  - `DiffHeader` *(Compare vX ↔ vY · changeCount)*
  - `VersionPicker` *(chọn 2 version bất kỳ)*
  - `SourceLineDiff` *(line-diff: addedLine teal / removedLine đỏ strike; Geist Mono)*
  - `RenderedSideBySide` *(2 pane render vX | vY; **stacked** ≤760)*
  - `ImageDiffSideBySide` *(doc ảnh: 2 ảnh cạnh nhau)*
  - `NoDiffState` *(2 version trùng → "Không có khác biệt")*

## What Already Exists

### System Impact & Technical Risks

- Repo greenfield. `doc_versions` định nghĩa ở `render-publish`; cụm này thêm
  history/restore/diff/re-anchor-trigger trên đó.
- Reuse: rendered side-by-side trong diff dùng lại viewer iframe của `render-publish`.
- Risk (medium-high): S-005 phụ thuộc hai chiều với `annotation-core` về model dữ
  liệu — phải build phối hợp, không tách rời.

## Not in Scope

- Thuật toán matching (block_id → snippet exact → fuzzy) + model annotation —
  `annotation-core`.
- Nhãn/tên/commit-message cho version — assumption: chỉ auto-number ở v0.
- Link ghim version cụ thể (`/d/:slug@v2`) — v0 link = latest. Defer.
- Overlay/swipe cho image diff; DOM-aware structural diff; inline merged rich-diff — defer.
- Prune/retention version cũ — giữ tất cả ở v0 (xem GAP-001).
- Real-time / live editor — v2.

## Gaps

- GAP-001 (status: open): storage growth — giữ tất cả version × tối đa 5MB HTML/25MB
  ảnh có thể phình DB; có nén / dedup theo content_hash / prune không? Couples
  `self-host`. Source: "Storage growth (self-host)".
- GAP-002 (status: resolved): `multi_range` mất bất kỳ segment nào → cả annotation
  detached. Chốt 2026-06-07; hành vi ở `annotation-core:AS-018`.
- GAP-003 (status: deferred): re-anchor chạy đồng bộ lúc tạo version hay job nền nếu
  chậm — đo lúc build. Source: "Re-anchor chạy đồng bộ … nếu chậm → job nền".
- GAP-004 (status: deferred): `@pierre/diffs` xử HTML thô tốt tới đâu, có cần
  pre-normalize trước khi diff. Source: "@pierre/diffs xử lý HTML thô tốt tới đâu".

## Clarifications — 2026-06-07

- **Restore = append-copy thay vì pointer-move:** lịch sử append-only dễ suy luận,
  không mơ hồ "current ở đâu", an toàn self-host (không mất bản cũ).
- **Chỉ content tạo version:** tránh version rác từ sửa title, nhẹ storage.
- **Diff two-level thay vì inline rich-diff:** inline đòi render HTML merge ở app
  origin → phá sandbox; side-by-side hai iframe giữ cách ly mà vẫn thấy thay đổi.
- **Re-anchor + detached:** đúng yêu cầu "anchor bền qua version" (§4.2); detached
  list đảm bảo không bao giờ mất feedback im lặng.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/versioning-diff.md) | -- |
| 2026-06-07 | GAP-002 resolved (multi_range all-or-nothing; see annotation-core:AS-018) | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
