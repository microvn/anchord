## Explore: annotation-core

_2026-06-07_

**Feature:** Chọn vùng text (hoặc vùng ảnh) trên doc đã render → để lại comment ở
cột lề phải; thread reply, resolve/unresolve, suggestion. Anchor neo bền qua
version. Là trái tim sản phẩm.

**Trigger:** Người xem (có quyền comment) bôi đen text / click-kéo trên ảnh → tạo
annotation. Re-anchor tự chạy khi versioning sinh version mới.

**UI expectation:** Layout 2 cột — nội dung (iframe sandbox cho HTML / app-render
cho MD / ảnh zoom-pan) bên trái, cột lề phải chứa thread comment thẳng hàng với
highlight. Reuse UX editor Plannotator. Toàn bộ **[N] NEW**.

---

### Nguồn tham khảo đã đọc (phiên explore)

- **Plannotator** (OSS, MIT/Apache, `github.com/backnotprop/plannotator`) —
  `packages/ui/components/html-viewer/bridge-script.ts`: bridge inject vào iframe,
  bắt selection → postMessage, render `<mark class="annotation-highlight"
  data-bind-id>`, re-anchor bằng `findTextAndMark` = `indexOf(originalText)` toàn
  doc. Lo sẵn theme/resize/scroll-to/focus/click.
- **uselink** (closed, đọc bundle `edit-DR6TUZo_.js`) — model anchor production:
  `anchor = { type: range|multi_range|block|doc, block_id, text_snippet, offset,
  length, segments[] }`; gán `data-block-id` cho block; `is_orphaned` + endpoint
  `comments.unorphan`; class `uselink-comment-anchor`, viewer trong iframe. Render
  MD bằng markdown-it.
- **W3C Web Annotation / Hypothesis** — TextQuoteSelector + fuzzy matching
  (apache-annotator, anchor-quote của Robert Knight).

---

### Quyết định (đã chốt trong phiên explore)

**1. Model anchor = block-scoped (theo uselink), tốt hơn Plannotator.**
```
anchor: {
  type: "range" | "multi_range" | "block" | "doc",
  block_id: string,         // neo theo BLOCK, không theo cả doc
  text_snippet: string,     // quote
  offset: number, length: number,   // vị trí trong block
  segments?: [{ block_id, text_snippet, offset, length }]  // multi_range
}
```
- Quote chỉ cần unique *trong block* → tự giải bài duplicate-quote (W3C phải dùng
  prefix/suffix mới làm được).
- Loại `block` = comment cả block; `doc` = comment toàn doc (không neo text).
- **doc-level:** annotation thuộc DOC, lưu descriptor anchor, re-resolve mỗi
  version (quyết định chung với cụm versioning-diff). Field `is_orphaned`.

**2. Transport = reuse bridge Plannotator + nâng matcher.**
- Reuse: inject agent vào iframe + postMessage (token handshake thay vì validate
  origin vì opaque origin = "null"); render mark; theme/resize/scroll/focus/click.
- **Thay** `findTextAndMark` (indexOf toàn doc) bằng: tìm block theo `block_id` →
  tìm `text_snippet` *trong block* (exact → fuzzy kiểu Hypothesis). Đây là phần
  code tự viết thêm so với Plannotator.
- Hai transport tuỳ render: HTML (sandbox) qua postMessage bridge; MD (app origin)
  + ảnh (app) truy cập DOM/toạ độ trực tiếp. Lớp UI annotation trừu tượng hoá trên.

**3. Gán block_id = server-side, khi serve content.**
- Một pass preprocess inject `data-block-id` vào block element (p/div/li/h*/pre/
  table…) + chèn bridge vào wrapper, rồi serve qua content-route. Củng cố quyết
  định **src + content-route** (không srcdoc). block_id sinh ổn định (theo nội
  dung + thứ tự) để bền khi block không đổi qua version.

**4. Anchor type 2 — image-region.**
- Click = point pin; kéo = box region. Lưu toạ độ **normalized 0..1 theo ảnh
  gốc** (bền khi zoom/đổi màn hình). Đây là ⭐ riêng anchord (uselink thiên text).

**5. Threading = flat (Google Docs).**
- Mỗi annotation 1 thread; reply phẳng, không lồng sâu. Khớp `comments.reply`
  uselink. (Schema có `parentId` nhưng v0 chỉ dùng 1 tầng.)

**6. Resolve = toggle, ai comment được thì resolve được, có reopen.**
- `status` resolved/unresolved; bất kỳ ai có quyền comment trở lên resolve/reopen.

**7. Suggestion mode = typed annotation + status, apply qua MCP.**
- Suggestion là loại annotation mang đề xuất (delete X / replace X→Y). Accept/reject
  = status. **anchord KHÔNG tự sửa content.** Agent kéo suggestion về qua MCP, sửa
  nguồn, republish → version mới. Hợp mô hình bất biến + round-trip.

**8. Guest authorship.**
- Comment lưu `authorId` (user) HOẶC `guestName` (+ email optional) khi khách
  comment. Việc *bật* guest commenting do cụm sharing-permissions (sub-toggle của
  anyone-with-link).

---

### Happy path

1. Reviewer mở link doc (quyền commenter), bôi đen câu "Thanh toán hết hạn sau 24h"
   trong spec HTML render ở iframe.
2. Bridge bắt selection → tính `{ block_id: "block-7", text_snippet, offset,
   length, type: "range" }` → postMessage ra parent; cột lề hiện ô nhập.
3. Reviewer gõ "Nên là 48h?" → submit → tạo annotation (doc-level) + comment đầu
   thread; mark vàng hiện trên text, thread thẳng hàng ở cột lề.
4. Tác giả mở link, thấy thread, reply "OK đổi", bấm resolve → mark mờ đi,
   `status=resolved`.

### Unhappy paths

- **Re-anchor sau version mới:** tác giả publish v3 sửa câu đó thành "hết hạn sau
  48 giờ". Re-anchor: tìm `block-7` → snippet cũ không khớp exact → fuzzy match
  trong block → vẫn neo được (text gần giống). Nếu block-7 bị xoá hẳn → annotation
  `is_orphaned=true`, vào danh sách **detached** để relocate/resolve.
- **Duplicate quote:** cùng cụm từ xuất hiện 2 nơi khác block → vẫn đúng vì neo
  theo block_id, không phải first-occurrence toàn doc.
- **Guest comment trùng tên:** hai khách cùng đặt "An" → phân biệt bằng id +
  thời điểm, hiển thị "An (khách)".
- **Selection rỗng / chỉ whitespace:** bridge bỏ qua, không tạo annotation.

---

### Business rules

- Annotation thuộc doc; mỗi version re-resolve anchor từ descriptor.
- Re-anchor: block_id → text_snippet exact → fuzzy → không thấy → orphaned.
- Suggestion không bao giờ tự sửa content; chỉ đổi status + round-trip MCP.
- Resolve là toggle, có lịch sử ai resolve (assumption).

### Input validation

- Comment body: không rỗng, max ~10k ký tự (assumption).
- guestName: bắt buộc khi khách comment; email optional, đúng format nếu có.
- anchor.type ∈ {range, multi_range, block, doc}; image-region coords ∈ [0,1].

### Permissions

- **Tạo annotation/comment/reply:** role commenter trở lên, hoặc khách (nếu doc bật
  guest commenting). Viewer: chỉ đọc.
- **Resolve/reopen:** ai comment được.
- **Sửa/xoá comment:** tác giả comment đó; owner/editor moderate (xoá bất kỳ).
- Chi tiết role/guest-toggle do cụm **sharing-permissions**.

### Data impact

- `annotations`: bỏ `docVersionId` (schema cũ neo vào version) → đổi sang **neo
  vào doc** + cột `anchor jsonb` (type/block_id/text_snippet/offset/length/segments)
  + `is_orphaned bool` + `status`. **Đây là thay đổi schema so với bản phác ban
  đầu, do quyết định doc-level.**
- `comments`: `annotationId`, `authorId` nullable, `guestName`, `body`, `parentId`
  (1 tầng), `createdAt`.
- Cần lưu `data-block-id` ổn định trong content đã serve (hoặc tính lại
  deterministic mỗi lần serve).

### Out of scope (v0 — defer)

- Reply lồng nhiều tầng (v0 flat).
- Reactions/emoji trên comment (uselink có `reactions.toggle`) → v0.5.
- Auto-apply suggestion vào content → không làm (mô hình bất biến).
- Real-time presence / con trỏ người khác → v2.
- Moderation nâng cao (uselink `comments.moderate`) → v0.5, v0 chỉ owner/editor xoá.

### Decision rationale

- Block-scoped thay vì nodePath/indexOf toàn doc: bền qua version + tự giải
  duplicate-quote; là model production đã chứng minh (uselink) thay vì brittle
  (Plannotator nguyên si).
- Reuse bridge Plannotator nhưng thay matcher: lấy ~30-50% công UI khó (select→
  mark→margin) mà vẫn đạt độ bền anchord cần.
- Suggestion không auto-edit: content nguồn nằm ở file của tác giả + immutable
  version; áp text-edit lên HTML đáng tin là rất khó và rủi ro. Round-trip MCP
  đúng tinh thần "agent kéo feedback về sửa tiếp".
- Flat thread: cột lề hẹp, lồng sâu khó đọc; Google Docs cũng flat.

### Assumptions (cần xác nhận)

- block_id sinh deterministic theo (nội dung block + thứ tự); giữ ổn định khi block
  không đổi. Thuật toán cụ thể chốt lúc build.
- Comment body max ~10k; có lịch sử resolve.
- MD (app-render) cũng gán block_id để dùng chung re-anchor engine.

### Open questions

- Thuật toán fuzzy trong block: ngưỡng "fuzziness" bao nhiêu thì coi là khớp vs
  orphan? (Hypothesis dùng diff-match-patch — cân nhắc.)
- block_id sinh thế nào để vừa ổn định vừa không đụng khi block bị chèn/xoá giữa
  chừng (sequential index sẽ shift; hash nội dung thì block trùng nội dung đụng id).
- `multi_range` (selection bắc qua nhiều block) re-anchor từng segment độc lập —
  một segment orphan thì cả annotation orphan hay một phần?
- Reuse `HtmlBlock`/`useHtmlAnnotation` của Plannotator (giả định srcdoc) cần
  adapt sang src+content-route bao nhiêu công — đo lúc build.
- Image-region: pin có cần dính theo scroll/zoom realtime không (overlay layer).

### Complexity signal: **high**

Cụm khó nhất sản phẩm: bridge cross-origin + block_id engine + re-anchor fuzzy +
ràng buộc hai chiều với versioning. Là nơi quyết định sản phẩm sống hay chết.

### Cross-cluster dependencies

- **versioning-diff:** trigger re-anchor khi version mới; model doc-level chốt
  chung. Ràng buộc hai chiều.
- **render-publish:** block_id inject + bridge inject vào content-route; iframe
  sandbox; ảnh zoom-pan cho image-region.
- **sharing-permissions:** ai comment/resolve/moderate; bật guest commenting.
- **mcp-roundtrip:** pull annotations (gồm suggestion) về cho agent; có thể có
  unorphan/relocate qua MCP.
- **workspace-project:** notify khi có reply (thuộc cross-cutting workspace).

## UI sketches

Dark-operator (xem `DESIGN.md`). Greenfield → tất cả `[N]` NEW. Doc ví dụ = chính
spec annotation-core (dogfood). Ký hiệu: `[Share]`=teal · `⬤`=teal · `▣`=detached/amber · `▢`=guest.

**Doc viewer + annotate (text)** `[N]` ← S-001 (text annotation block-scoped) /S-003
(reply flat) /S-004 (resolve) /S-006 (suggestion) /S-007 (guest) · render-publish
S-002 (HTML sandbox) · versioning S-005 (detached)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▤ ‹ ⚓ annotation-core ⬤LIVE [HTML] v2·16:34  ↶↷ [Preview|Edit] 💬 [Share] ◐ ⋯│
├──────────────────────────────────────────────────────────────────────────┤
│ SPEC · annotation-core · v2 · 7 stories · 22 AS · [Draft]  …/d/annotation-core│
├────────────┬───────────────────────────────────────────┬─────────────────┤
│ Tìm mục…   │  ⌖ Select | ✎ Markup   bôi đen để comment   │ ANNOTATIONS   3 │
│ STORIES  7 │  annotation-core            (Fraunces)       │ ┃"block_id là    │
│ ▸P0 S-001◀ │  S-001 Create a text annotation              │ │ positional hint"│
│  P0 S-002  │  Bôi đen → comment cột lề, neo theo          │ │⬤Lan        2h  │
│  P1 S-003  │  ▁block_id (positional hint)▁ + text_snippet │ │block_id ổn định?│
│  P1 S-004  │       ┌─────────────┐ ←popover                │ ┕━━━━━━━━━━━━━━━ │
│  P0 S-005  │       │💬 ✦ ✓ 👍 ✕│                          │ ?Mèo  [suggest] │
│  P1 S-006  │  C-001: anchor block-scoped; snippet unique  │ "hint"→"best-eff"│
│  P1 S-007  │  trong block.                                │ ⬤Hoàng[resolved]│
│ CONSTRAINTS│  ┌ anchor jsonb ──────────┐   (Geist Mono)   │ DETACHED      1 │
│  C-001..012│  │ {type,block_id,         │                 │ ?An  ▣detached  │
│            │  │  text_snippet,offset}   │                 │ "AS-018 đã đổi" │
│            │  └─────────────────────────┘                 │ [Trả lời…] [Gửi]│
└────────────┴───────────────────────────────────────────┴─────────────────┘
   TOC (search+scroll-spy+P-badge)     doc ~760px          annotations rail
```

**Mobile (<600, responsive)** `[N]` — TOC + rail thành drawer/bottom-sheet
```
┌──────────────────────┐
│ ▤  annotation-core ⋯ │
│  S-001 …neo theo     │
│  ▁block_id▁ + snippet│ ← tap highlight = mở thread
│        ╭───────────╮ │
│        │ 💬 3  ▣1   │ │ ← FAB → bottom-sheet comment
│        ╰───────────╯ │
└──────────────────────┘
```

**Image-region** `[N]` ← S-002 (click=point, drag=box, toạ độ normalized 0..1 bền
khi zoom) · render-publish S-004 (ảnh zoom/pan)
```
┌──────────────────────────────────────────┬─────────────────┐
│ ⚓ checkout-wireframe [IMG] v2  [Share] ⋯  │ ANNOTATIONS   2 │
│   ┌────────────────────────────────────┐ │ ⬤Lan  ◉point    │
│   │  ███ ảnh ███               ◉←pin   │ │ "nút này nhỏ"   │
│   │   ┌╌╌╌┐ ← box (drag)               │ │ ⬤Hoàng ▢box     │
│   │   └╌╌╌┘                            │ │ "vùng lệch"     │
│   └────────────────────────────────────┘ │ toạ độ 0..1     │
│   [ − ⊕ + ] zoom/pan                      │                 │
└──────────────────────────────────────────┴─────────────────┘
```
