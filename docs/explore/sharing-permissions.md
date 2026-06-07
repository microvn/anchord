## Explore: sharing-permissions

_2026-06-07_

**Feature:** Mô hình chia sẻ kiểu Google Docs cho doc: 4 role, 3 mức general-access,
guest commenting, invite by email, và control trên link (password/expiry/view-limit).
Quyết định "ai mở được link, ai làm được gì".

**Trigger:** Owner/editor mở hộp "Share" trên doc → đặt general-access + role, mời
email, bật/tắt guest commenting, đặt password/expiry/limit.

**UI expectation:** Hộp Share kiểu Google Docs: danh sách người + role, dropdown
general-access, ô mời email + role + lời nhắn, khu vực link (copy, password,
expiry, view-limit). Toàn bộ **[N] NEW**.

---

### Quyết định (đã chốt trong phiên explore)

**1. Share model = 1 general-access + control trên link (Google Docs).**
Mỗi doc một thiết lập general-access duy nhất, KHÔNG nhiều named link. Password/
expiry/view-limit gắn vào link của doc.

**2. Ba mức general-access (kèm role cho link):**
- `restricted` — chỉ người được mời cụ thể.
- `anyone_with_link` — ai có link đều truy cập; chọn role cho link (viewer/
  commenter). + sub-toggle guest commenting.
- `anyone_in_workspace` — mọi member workspace; chọn role.

**3. Anonymous view + tên ngẫu nhiên.**
- `anyone_with_link` cho **xem ẩn danh, không cần account**.
- Người ẩn danh được gán **tên ngẫu nhiên** (vd "Cá Heo Ẩn Danh"); nếu chủ động
  đổi tên thì cập nhật. Comment khi doc bật guest commenting (nhập tên + email
  optional, vẫn không cần account).

**4. Link controls — cả 3, đều optional.**
- Password (optional): nhập đúng mới vào.
- Expiry (optional): quá hạn → link hết hiệu lực.
- View-limit (optional): tổng lượt mở; vượt → link hết hiệu lực.
- Hết hiệu lực → trang "Link không còn khả dụng" (+ nút request access nếu owner bật, v0.5).

**5. Invite by email = pending invite + email.**
- Mời email + role + lời nhắn → gửi email; nếu chưa có account → lời mời **treo**
  gắn email; họ sign up bằng email đó → tự nhận role. Couples cụm **auth**.

**6. 4 role + năng lực (doc-level):**
| Role | Xem | Comment/reply/resolve | Tạo version / sửa content | Share / xoá / transfer |
|---|---|---|---|---|
| viewer | ✅ | ❌ | ❌ | ❌ |
| commenter | ✅ | ✅ | ❌ | ❌ |
| editor | ✅ | ✅ | ✅ | ❌ |
| owner | ✅ | ✅ | ✅ | ✅ |

**7. Precedence = role cao nhất thắng.**
Nếu một người vừa được invite (editor) vừa rơi vào general-access (commenter) →
nhận editor.

---

### Happy path

1. Owner mở Share trên "Payment Spec", đặt general-access = anyone_with_link, role
   = commenter, bật guest commenting, đặt expiry 7 ngày.
2. Copy link gửi cho reviewer ngoài (không có account).
3. Reviewer mở link → xem được ngay, hệ thống gán tên "Mèo Ẩn Danh"; bôi đen text
   comment → nhập tên thật "Lan" + email → comment lưu với guestName "Lan".
4. Owner mời thêm `bob@x.com` role editor + lời nhắn "review giúp phần refund" →
   Bob chưa có account → nhận email mời; Bob sign up → vào doc với role editor.

### Unhappy paths

- **Quá hạn:** sau 7 ngày, mở link → "Link không còn khả dụng". (v0 chưa có request
  access.)
- **Sai password:** nhập sai → báo lỗi, không lộ nội dung.
- **Restricted + người lạ:** doc restricted, người không được mời mở link → "Bạn
  không có quyền truy cập" (v0 chưa có request access).
- **Viewer cố comment:** UI không hiện ô comment; API từ chối nếu cố gọi.

### Business rules

- Một general-access setting/doc; link controls optional độc lập nhau.
- Role cao nhất thắng khi nhiều nguồn quyền.
- Guest commenting chỉ khả dụng khi general-access = anyone_with_link.
- Invite treo gắn theo email, kích hoạt khi account email đó tồn tại.

### Input validation

- Email mời: đúng format; role ∈ {viewer, commenter, editor, owner}.
- Password link: min 4 ký tự (assumption).
- Expiry: ngày tương lai. View-limit: số nguyên > 0.
- guestName: không rỗng khi guest comment; email optional đúng format.

### Permissions (về chính việc share)

- **Đổi general-access / mời / đặt link controls / transfer:** owner. Editor có
  thể mời ở mức ≤ role mình? (assumption: chỉ owner quản share ở v0).
- **Xem ai đang có quyền:** owner/editor.

### Data impact

- `docs.general_access` (enum, đã có trong schema phác).
- Bảng mới: `doc_shares` / `doc_members` (userId|email pending, role, message,
  invitedBy) + `share_links` (docId, role, passwordHash?, expiresAt?, viewLimit?,
  viewCount).
- `comments.guestName` (đã có); thêm cơ chế tên ngẫu nhiên cho anon viewer (có thể
  chỉ là session-level, không cần lưu nếu chưa comment).
- Pending invite cần được auth pick up khi sign up (couples auth).

### Out of scope (v0 — defer)

- Request access + owner duyệt → v0.5.
- Transfer ownership → v0.5 (đưa vào bảng nhưng UI defer).
- Nhiều named share-link/doc → v0.5+.
- Project/workspace default share settings, project role override → cụm
  workspace-project (v0.5).
- Chặn copy/download cho viewer → v2.
- Editor được mời người khác → v0 chỉ owner quản share.

### Decision rationale

- Single general-access thay vì multi-link: đơn giản, đúng Google Docs; multi-link
  thêm gánh quản lý/revoke chưa cần ở v0.
- Anon view + tên ngẫu nhiên: đúng wedge "gửi cho người không có account"; tên
  ngẫu nhiên cho trải nghiệm comment liền mạch trước khi người ta tự xưng tên.
- Pending invite: cho phép mời người mới (không chỉ người có sẵn account) — cần cho
  cộng tác thật; chấp nhận coupling với auth.
- Cả 3 link control: §4.3 đánh v0; đều optional nên không ép phức tạp khi không dùng.

### Assumptions (cần xác nhận)

- Chỉ owner quản lý share ở v0 (editor không mời người).
- Anon name ngẫu nhiên là session-level, chỉ persist khi guest comment.
- Password link min 4 ký tự; expiry tính theo ngày.

### Open questions

- View-limit đếm tổng lượt mở hay unique viewer? (đề xuất: tổng lượt mở, đơn giản).
- anyone_in_workspace ở v0 single-workspace gần như = mọi member — có khác biệt
  thực tế nào với anyone_with_link nội bộ không? Xác nhận khi workspace cluster rõ.
- Pending invite hết hạn sau bao lâu? Có cần không?
- Password lưu hash (bcrypt/argon2) — chốt cùng auth.

### Complexity signal: **medium**

Mô hình rõ (Google Docs), nhưng nhiều mặt: roles × access × link controls × guest
× pending invite, và coupling với auth (pending) + workspace (anyone_in_workspace).

### Cross-cluster dependencies

- **auth:** pending invite kích hoạt khi sign up; password hashing chung.
- **annotation-core:** role quyết định ai comment/resolve/moderate; guest toggle
  bật/tắt guest commenting; guestName.
- **render-publish / versioning-diff:** general-access quyết định ai mở `/d/:slug`;
  role editor+ mới tạo version.
- **workspace-project:** anyone_in_workspace; default share settings + project role
  override (v0.5); workspace member directory.
- **mcp-roundtrip:** agent publish/pull có thể cần token/role tương ứng.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW. `⬤`=teal · `▢`=pending.

**Share dialog** `[N]` ← S-001 (3 tier) /S-003 (invite pending) /S-004 (link
password/expiry/view-limit) /S-005 (roles+precedence C-002) · C-003 (guest toggle)
```
┌──────────────────────────────────────────┐
│ ⚓ Share        annotation-core         ✕ │
│ GENERAL ACCESS                            │
│ [Restricted][anyone-in-workspace][⬤anyone-with-link] [Commenter▾]│
│ Guest commenting (tên+email)        ●──○  │ ← C-003
│ LINK  [ …/d/annotation-core      ] [Copy] │
│ (🔒 password)(⏲ expiry 7d)(view-limit off)│ ← S-004
│ INVITE [ email… ][Editor▾] [Invite]       │ ← S-003 pending
│ PEOPLE  ⬤HG Hoàng — owner                  │
│         ▢bob@x.com — editor · pending      │
│         ⬤Lan — commenter (role cao nhất thắng, C-002)│
└──────────────────────────────────────────┘   (mobile: full-screen sheet)
```
