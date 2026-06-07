## Explore: versioning-diff

_2026-06-07_

**Feature:** Mỗi lần nộp content mới tạo một version bất biến; xem lịch sử,
restore version cũ, và diff giữa hai version. Là nền cho "anchor bền qua version"
của annotation.

**Trigger:** Tác giả nộp content mới (upload/paste/MCP) → version mới. Restore và
diff là hành động tay trên UI lịch sử version.

**UI expectation:** Panel "Version history" trên trang doc: danh sách v1..vN
(thời gian, người publish), nút Restore từng version, nút "Compare" chọn 2 version
→ màn diff. Toàn bộ **[N] NEW**.

---

### Quyết định (đã chốt trong phiên explore)

**1. Cái gì tạo version — chỉ content.**
Mỗi lần nộp content mới (upload/paste/MCP update) = một version bất biến mới,
append, không ghi đè. **Title là metadata mutable trên doc, KHÔNG version hoá.**
Không có draft/autosave ở v0 (mô hình async, publish-based — không có live editor).

**2. Restore = append-copy (kiểu git revert).**
Restore version cũ → tạo version MỚI copy nội dung version được chọn. Lịch sử
append-only, không mất gì, không có khái niệm "xoá version sau". "Current" luôn là
version mới nhất.

**3. Anchor carry-forward = re-anchor + detached list. (CRUX của sản phẩm)**
Khi version N+1 ra đời, annotation từ version N **tự động neo lại** vào content
mới qua content-hash/fuzzy match:
- Khớp → annotation theo sang version mới (feedback theo doc).
- Không khớp → vào danh sách **"detached"** để tác giả/reviewer relocate hoặc
  resolve.
- **Phân vai:** cụm versioning-diff định nghĩa *trigger* (version mới → chạy
  re-anchor cho annotation của version trước) và *hành vi*. *Thuật toán* matching
  + model dữ liệu annotation (annotation thuộc doc hay thuộc version) thuộc cụm
  **annotation-core**. Đây là điểm khớp bắt buộc giữa hai cụm.

**4. Diff = two-level (theo research 2026), điều chỉnh cho sandbox.**
- **HTML:** source/text line-diff (`@pierre/diffs`) **+** rendered side-by-side
  = hai iframe sandbox cạnh nhau (A | B). KHÔNG merge-inline-diff trong app origin
  (vi phạm model sandbox — HTML không tin cậy không chạy ở origin tin cậy).
- **Markdown:** line-diff source (đọc tốt vì MD là plain text) + rendered
  side-by-side (bonus rẻ).
- **Ảnh:** side-by-side. Overlay/swipe → defer.
- Chọn **2 version bất kỳ** để so, không chỉ liền kề.
- Tránh approach "HTML→MD→diff→ngược" (HtmlDiff đã deprecated, kết quả sai).
- Defer: DOM-aware structural diff, inline merged rich-diff.

---

### Happy path

1. Tác giả mở doc "Payment Spec" (đang ở v2), bấm "Version history" → thấy v1, v2.
2. Re-upload `spec.html` đã sửa → hệ thống tạo **v3** (bất biến), current = v3.
3. Annotation từ v2 chạy re-anchor: 5/6 comment khớp → theo sang v3; 1 comment
   không khớp → vào "detached (1)".
4. Tác giả bấm "Compare v2 ↔ v3" → màn diff: cột source highlight dòng đổi + dưới
   là hai iframe render v2 | v3 cạnh nhau.

### Unhappy paths

- **Restore:** tác giả thấy v3 sai, bấm "Restore v1" → tạo **v4 = copy nội dung
  v1**. Current = v4. v2/v3 vẫn còn trong lịch sử. Annotation re-anchor từ v3 sang
  v4 như mọi version mới.
- **Diff hai version giống hệt:** chọn so 2 version trùng nội dung → màn diff báo
  "Không có khác biệt", rendered side-by-side vẫn hiện.
- **Detached nhiều:** sửa lớn khiến đa số comment không khớp → danh sách detached
  dài; tác giả xử lý ở UI annotation (cụm annotation-core), không mất comment.

---

### Business rules

- Version đánh số tự tăng v1, v2, v3… liên tục, không tái sử dụng số.
- Version bất biến: content + content_hash + người publish + thời điểm, không sửa
  sau khi tạo.
- Current = version số lớn nhất. Restore không xoá, chỉ append.
- Re-anchor chạy đồng bộ ngay khi version mới được tạo (hoặc job ngay sau) — chi
  tiết ở annotation-core.

### Input validation

- Compare: phải chọn đúng 2 version; không cho so version với chính nó (hoặc cho
  nhưng báo "không khác biệt").
- Restore: version đích phải tồn tại và thuộc doc.

### Permissions

- **Xem history + diff:** ai xem được doc (theo general-access của cụm sharing).
- **Tạo version mới / restore:** role editor/owner (chi tiết role do cụm sharing).
  Viewer/commenter không tạo/restore version.

### Data impact

- `doc_versions` (đã phác schema): `version int`, `content text`, `content_hash`,
  `published_by`, `created_at`, unique (doc_id, version).
- Title nằm trên `docs` (mutable), không trên version.
- Re-anchor cần model annotation tham chiếu version — quyết định ở annotation-core
  (annotation thuộc doc + lưu anchor resolved theo từng version, HAY annotation
  thuộc version + carry-forward tạo bản sao). Ảnh hưởng schema `annotations`.

### Out of scope (v0 — defer)

- Nhãn/tên tuỳ chỉnh cho version + "commit message" khi publish → assumption: chỉ
  auto-number ở v0.
- Link ghim tới một version cụ thể (`/d/:slug@v2`) → v0 share link = latest. Defer.
- Overlay/swipe cho image diff; DOM-aware structural diff; inline merged rich-diff.
- Prune/retention version cũ → giữ tất cả ở v0 (xem open question storage).
- Real-time / live editor → v2 (mô hình async, không có draft).

### Decision rationale

- Append-copy thay vì pointer-move: lịch sử append-only dễ suy luận, không mơ hồ
  "current ở đâu", an toàn cho self-host (không bao giờ mất bản cũ).
- Chỉ content tạo version: tránh version rác từ sửa title, nhẹ storage.
- Two-level diff thay vì inline rich-diff: inline đòi render HTML merge ở app
  origin → phá sandbox. Side-by-side hai iframe giữ được cách ly mà vẫn thấy thay
  đổi hiển thị.
- Re-anchor + detached: đúng yêu cầu "anchor bền qua version" của design doc §4.2,
  là payoff differentiator; detached list đảm bảo không bao giờ mất feedback im lặng.

### Assumptions (cần xác nhận)

- v0 share link trỏ latest; không ghim version.
- Không có version note/message ở v0.
- Re-anchor chạy đồng bộ lúc tạo version (đủ nhanh cho doc ≤5MB); nếu chậm →
  chuyển job nền (đo lúc build).

### Open questions

- **Storage growth (self-host):** giữ tất cả version × tối đa 5MB HTML/25MB ảnh có
  thể phình DB nhanh. Có cần nén content, dedup theo content_hash (version trùng
  nội dung chỉ lưu 1 lần), hay prune? → couples cụm **self-host**.
- Model annotation cho re-anchor (thuộc doc vs thuộc version) → chốt ở
  **annotation-core**, ảnh hưởng ngược schema version.
- @pierre/diffs xử HTML thô tốt tới đâu (token-level hay line-level), có cần
  pre-normalize HTML trước khi diff không.
- Ảnh diff side-by-side: cần resize đồng cỡ hay giữ nguyên?

### Complexity signal: **medium-high**

Version + restore + diff bản thân là medium. Phần đẩy lên high là *trigger
re-anchor* và sự phụ thuộc hai chiều với annotation-core về model dữ liệu — phải
chốt cùng nhau khi /mf-plan, không tách rời.

### Cross-cluster dependencies

- **annotation-core:** thuật toán re-anchor + model annotation (doc vs version) —
  ràng buộc hai chiều, quyết định cùng lúc.
- **render-publish:** version sinh ra từ content nộp ở cụm đó; iframe sandbox tái
  dùng cho rendered side-by-side.
- **sharing-permissions:** ai xem history/diff, ai được tạo version/restore.
- **mcp-roundtrip:** MCP update doc = tạo version mới (map vào trigger ở đây).
- **self-host:** chiến lược storage/retention cho lịch sử version.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW.

**Version history + diff** `[N]` ← S-002 (history) /S-003 (restore append-copy)
/S-004 (diff two-level: source line-diff + rendered side-by-side). Ví dụ = diff
thật v1→v2 của annotation-core sau /mf-challenge (18→22 AS).
```
┌────────────────────────────────────────────────────────────────┐
│ ⚓ annotation-core                       [Restore v1] [History]  │
├──────────┬──────────────────────────────────────────────────────┤
│ VERSIONS │ Compare v1 ↔ v2 · 2 changes                          │
│  v2 cur  │ ┌── source diff (Geist Mono) ──────────────────────┐ │
│ ▸v1  3h◀ │ │   C-001: anchor block-scoped                     │ │
│          │ │ + block_id là positional hint (inject publish)   │ │ ←teal
│          │ │ + C-008..C-012 harden                            │ │
│          │ └──────────────────────────────────────────────────┘ │
│          │ ┌ v1 rendered ─┐ ┌ v2 rendered ─┐ (≤760: stacked)   │
│          │ │ 18 AS        │ │ 22 AS +4      │                   │
└──────────┴──────────────────────────────────────────────────────┘
```
