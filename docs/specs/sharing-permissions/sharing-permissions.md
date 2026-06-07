# Spec: sharing-permissions

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

Mô hình chia sẻ kiểu Google Docs cho doc: 4 role (viewer/commenter/editor/owner),
3 mức general-access, xem ẩn danh + guest commenting, invite by email (pending nếu
chưa có account), và control trên link (password/expiry/view-limit). Quyết định "ai
mở được link, ai làm được gì".

## Data Model

- **docs.general_access**: restricted | anyone_with_link | anyone_in_workspace
  (định nghĩa ở `render-publish`).
- **doc_members**: `doc_id`, `user_id` (nullable nếu pending), `email` (cho pending),
  `role`, `message`, `invited_by`, `status` (active | pending), `created_at`.
- **share_links**: `doc_id`, `role` (cho anyone-with-link), `password_hash` (nullable),
  `expires_at` (nullable), `view_limit` (nullable), `view_count`.
- Guest commenting là sub-toggle của anyone-with-link; `guest_name` trên comment ở
  `annotation-core`.

## Stories

### S-001: Set general-access for a doc (P0)

**Description:** Là owner, tôi đặt mức truy cập chung cho doc và role kèm theo, và
bật/tắt guest commenting khi mở cho ai có link.
**Source:** docs/explore/sharing-permissions.md#quyết-định (mục 1, 2).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (dự kiến `src/routes/share.*`, `src/db/schema`)
- `autonomous:` true
- `verify:` đặt anyone-with-link+commenter → link mở được bởi người ngoài ở mức comment.

**Acceptance Scenarios:**

AS-001: Đặt anyone-with-link với role commenter
- **Given:** owner mở hộp Share của doc
- **When:** chọn general-access = anyone-with-link, role = commenter
- **Then:** lưu thiết lập; người có link truy cập được ở mức commenter
- **Data:** anyone-with-link + commenter

AS-002: Đặt restricted
- **Given:** owner mở hộp Share
- **When:** chọn general-access = restricted
- **Then:** chỉ người được mời cụ thể mới truy cập; người có link mà không được mời bị từ chối
- **Data:** restricted

AS-003: Guest commenting chỉ bật được khi anyone-with-link
- **Given:** doc đang để restricted
- **When:** owner cố bật guest commenting
- **Then:** toggle guest commenting không khả dụng cho tới khi chuyển sang anyone-with-link
- **Data:** restricted → toggle disabled

### S-002: Open a doc via link as anonymous (P0)

**Description:** Là người mở link không có account, tôi xem được doc với một tên
ngẫu nhiên, và đổi tên nếu muốn.
**Source:** docs/explore/sharing-permissions.md#quyết-định (mục 3 anon view).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-004: Xem ẩn danh với tên ngẫu nhiên
- **Given:** doc để anyone-with-link
- **When:** người không đăng nhập mở link
- **Then:** xem được nội dung; được gán tên ngẫu nhiên (vd "Mèo Ẩn Danh") cho phiên
- **Data:** không account

AS-005: Đổi tên ẩn danh
- **Given:** người ẩn danh đang xem với tên ngẫu nhiên
- **When:** chủ động đổi tên thành "Lan"
- **Then:** tên hiển thị cập nhật "Lan" cho phiên (và gắn vào comment nếu họ comment)
- **Data:** đổi "Mèo Ẩn Danh" → "Lan"

AS-006: Restricted + người lạ bị từ chối
- **Given:** doc để restricted
- **When:** người không được mời mở link
- **Then:** hiện "Bạn không có quyền truy cập"; không lộ nội dung (v0 chưa có request access)
- **Data:** người ngoài danh sách mời

AS-015: anyone_in_workspace — member vào được, người ngoài/ẩn danh không
- **Given:** doc để anyone_in_workspace
- **When:** một member đã đăng nhập mở link (không cần được mời đích danh); và một
  người không đăng nhập / không phải member mở cùng link
- **Then:** member vào được; người không đăng nhập hoặc ngoài workspace bị từ chối
- **Data:** member nội bộ vs khách ẩn danh

### S-003: Invite by email with role (P0)

**Description:** Là owner, tôi mời người khác bằng email + role + lời nhắn; người
chưa có account nhận lời mời treo, kích hoạt khi họ đăng ký.
**Source:** docs/explore/sharing-permissions.md#quyết-định (mục 5 invite pending).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (phối hợp auth)
- `autonomous:` true
- `verify:` mời email chưa có account → tạo pending; sign up email đó → nhận role.

**Acceptance Scenarios:**

AS-007: Mời người đã có account
- **Given:** owner mở Share; `dev@acme.com` đã có account
- **When:** mời `dev@acme.com` role editor + lời nhắn, gửi
- **Then:** người đó nhận role editor trên doc + được notify
- **Data:** editor + lời nhắn "review giúp"

AS-008: Mời email chưa có account → pending, kích hoạt khi sign up
- **Given:** owner mời `bob@x.com` role editor; Bob chưa có account
- **When:** lời mời được tạo (gửi email nếu có SMTP); sau đó Bob sign up bằng đúng
  `bob@x.com` (email verified)
- **Then:** lời mời kích hoạt; Bob vào doc với role editor
- **Data:** email chưa tồn tại lúc mời

### S-004: Apply link controls (P1)

**Description:** Là owner, tôi đặt password / hạn / giới hạn lượt mở cho link; quá
hạn hoặc vượt giới hạn thì link hết hiệu lực.
**Source:** docs/explore/sharing-permissions.md#quyết-định (mục 4 link controls).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Link có password
- **Given:** owner đặt password cho link
- **When:** người mở link nhập sai password
- **Then:** từ chối, không lộ nội dung; nhập đúng thì vào được
- **Data:** password đặt; thử sai rồi đúng

AS-010: Link quá hạn hết hiệu lực
- **Given:** owner đặt expiry 7 ngày
- **When:** người mở link sau khi quá hạn
- **Then:** hiện "Link không còn khả dụng"
- **Data:** expiry trong quá khứ

AS-011: Vượt giới hạn lượt mở
- **Given:** owner đặt view-limit = tổng số lượt mở
- **When:** lượt mở vượt giới hạn
- **Then:** hiện "Link không còn khả dụng"
- **Data:** view-limit nhỏ, mở quá số đó

AS-016: Password link bị rate-limit chống brute-force [harden M2]
- **Given:** link có password
- **When:** thử sai password nhiều lần liên tiếp
- **Then:** sau ngưỡng → tạm khoá/đợi (không cho đoán tốc độ HTTP)
- **Data:** thử sai lặp lại

AS-017: view-limit không vượt khi mở đồng thời [harden M2]
- **Given:** view-limit = N
- **When:** N+M request mở link gần như đồng thời
- **Then:** chỉ ≤ N request được phục vụ (increment atomic), phần dư bị từ chối
- **Data:** N=5, bắn 20 request song song

### S-005: Enforce role capabilities & precedence (P0)

**Description:** Là hệ thống, tôi áp đúng năng lực theo role và lấy role cao nhất khi
một người có quyền từ nhiều nguồn.
**Source:** docs/explore/sharing-permissions.md#quyết-định (mục 6 roles, mục 7 precedence).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-012: Viewer không comment được
- **Given:** người dùng có role viewer trên doc
- **When:** họ mở doc
- **Then:** không có ô comment; nếu cố gọi tạo comment → bị từ chối
- **Data:** viewer

AS-013: Role cao nhất thắng khi nhiều nguồn
- **Given:** người được invite editor, đồng thời general-access là anyone-with-link/commenter
- **When:** họ mở doc
- **Then:** nhận role editor (cao hơn commenter)
- **Data:** invited=editor + link=commenter

AS-014: Chỉ owner quản lý share
- **Given:** người dùng có role editor (không phải owner)
- **When:** họ mở hộp Share để đổi general-access/mời người
- **Then:** không được phép (v0 chỉ owner quản share)
- **Data:** editor cố đổi access

## Constraints & Invariants

- C-001: Một general-access setting/doc; link controls (password/expiry/view-limit)
  gắn vào link, độc lập nhau. (AS-001, AS-002, AS-009, AS-010, AS-011)
- C-002: Role cao nhất thắng khi quyền đến từ nhiều nguồn. (AS-013)
- C-003: Guest commenting chỉ khả dụng khi general-access = anyone-with-link. (AS-003)
- C-004: anyone-with-link cho xem ẩn danh không cần account; gán tên ngẫu nhiên, đổi được. (AS-004, AS-005)
- C-005: Link quá hạn hoặc vượt view-limit → hết hiệu lực (trang "không khả dụng"). (AS-010, AS-011)
- C-006: Pending invite gắn theo email, kích hoạt khi account email đó tồn tại + verified. (AS-008)
- C-007: v0 chỉ owner quản lý share (đổi access, mời, link controls). (AS-014)
- C-008: view-limit đếm TỔNG lượt mở (không phải unique viewer). (AS-011)
- C-009: Ba mức general-access phân biệt rõ: restricted (chỉ người mời) <
  anyone_in_workspace (mọi member đã đăng nhập, không anon/người ngoài) <
  anyone_with_link (cả anon/người ngoài). (AS-002, AS-004, AS-015)
- C-010 [harden M2]: password link lưu hash bằng cùng KDF với user password
  (argon2id/bcrypt) + rate-limit/lockout như đăng nhập (mở rộng auth C-007 sang
  link password). (AS-016)
- C-011 [harden M2]: enforce view-limit bằng increment atomic
  (`UPDATE … SET view_count=view_count+1 WHERE view_count<view_limit RETURNING`,
  không có row → từ chối); check expiry/limit server-side mỗi request trước khi
  serve content. (AS-017)

## UI Notes

Từ `docs/explore/sharing-permissions.md` §UI sketches. Greenfield → `[N]`. Component
names only. Dark-operator (`DESIGN.md`). Precedence: AS > Tree.

- `ShareDialog` `[N]` *(modal; **full-screen sheet** ≤600)*
  - `GeneralAccessSegmented`: Restricted · AnyoneInWorkspace · AnyoneWithLink + `RoleDropdown`
  - `GuestCommentingToggle` *(chỉ bật được khi AnyoneWithLink — C-003)*
  - `LinkRow`: urlField · CopyButton · `PasswordChip` · `ExpiryChip` · `ViewLimitChip` *(đều optional)*
  - `InviteRow`: emailField · `RoleDropdown` · InviteButton *(pending nếu chưa có account)*
  - `PeopleList` → `PersonRow`: `Avatar` · name · roleLabel · `PendingTag`

## What Already Exists

### System Impact & Technical Risks

- Repo greenfield. `docs.general_access` định nghĩa ở `render-publish`; cụm này thêm
  doc_members/share_links + enforcement.
- Cross-spec: gate truy cập link `/d/:slug` của `render-publish`/`versioning-diff`
  theo general-access; bật guest commenting + ai comment/resolve ở `annotation-core`.
- Risk: pending-invite phụ thuộc `auth` (kích hoạt lúc sign up). Password link hash
  dùng tiện ích của better-auth (`auth`).

## Not in Scope

- Request access + owner duyệt — v0.5.
- Transfer ownership — v0.5 (bảng có chỗ, UI defer).
- Nhiều named share-link/doc — v0.5+.
- Project/workspace default share settings, project role override — `workspace-project` (v0.5).
- Chặn copy/download cho viewer — v2.
- Editor được mời người khác — v0 chỉ owner.

## Linked Fields

- `general_access` — produced bởi spec này (AS-001/002). Consumed bởi
  `render-publish`/`versioning-diff` khi gate mở link `/d/:slug`. ✔ enforcement định
  nghĩa ở S-005; cụm kia chỉ kiểm tra trước khi serve.
- **pending invite (email→role)** — produced bởi S-003 (AS-008). Consumed bởi
  `auth` lúc sign up để gán role. ✔ auth pick-up theo email verified.

## Gaps

- GAP-001 (status: resolved → AS-015, C-009): giữ 3 mức; anyone_in_workspace =
  member đã đăng nhập (không anon/người ngoài), khác hẳn anyone_with_link. (Chốt 2026-06-07.)
- GAP-002 (status: open): pending invite hết hạn sau bao lâu? Có cần không? Source:
  "Pending invite hết hạn sau bao lâu".
- GAP-003 (status: resolved → C-010): password link hash bằng argon2id/bcrypt (cùng
  KDF user password) + rate-limit. (Chốt 2026-06-07 qua /mf-challenge M2.)

## Clarifications — 2026-06-07

- **Single general-access thay vì multi-link:** đơn giản, đúng Google Docs;
  multi-link thêm gánh quản lý/revoke chưa cần ở v0.
- **Anon view + tên ngẫu nhiên:** đúng wedge "gửi cho người không có account"; tên
  ngẫu nhiên cho trải nghiệm liền mạch trước khi người ta tự xưng tên.
- **Pending invite:** cho phép mời người mới (không chỉ người có sẵn account); chấp
  nhận coupling với auth.
- **Cả 3 link control, đều optional:** §4.3 đánh v0; optional nên không ép phức tạp.
- **view-limit đếm tổng lượt mở** (không unique) — đơn giản, rõ ràng.
- **v0 chỉ owner quản share** (editor không mời người).
- **Giữ 3 mức general-access:** anyone_in_workspace (nội bộ đã đăng nhập, không lộ
  ra ngoài) là case "chia sẻ cả team" hay gặp, khác hẳn anyone_with_link (công khai
  cả anon); rẻ (chỉ kiểm tra membership). Giữ luôn cho multi-workspace v2.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/sharing-permissions.md) | -- |
| 2026-06-07 | GAP-001 resolved → AS-015 + C-009 (giữ 3 mức general-access) | -- |
| 2026-06-07 | /mf-challenge harden M2: C-010/C-011 + AS-016/AS-017 (password rate-limit+hash, view-limit atomic); GAP-003 resolved | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
