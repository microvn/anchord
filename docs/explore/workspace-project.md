## Explore: workspace-project

_2026-06-07_

**Feature:** Tầng tổ chức 3 cấp Workspace → Project → Doc; quản lý member, project
CRUD, browse/move/copy doc, search, và notify khi có reply. v0 single-workspace.

**Trigger:** First-run tạo workspace + admin. Sau đó: member tạo project/doc, mời
member, search, nhận notify.

**UI expectation:** Sidebar project list; project view list/grid doc (sort/filter);
member directory (admin); search bar; notification center (in-app). **[N] NEW**.

---

### Quyết định (đã chốt trong phiên explore)

**1. Single workspace = instance (v0).**
- First-run setup: user đầu tiên → **instance admin**, tạo workspace (tên, branding,
  default access, provider toggle). Không có workspace switcher, không create-
  workspace flow. Multi-workspace/1-instance → **v2**.

**2. Vai trò + ai làm gì.**
- Workspace roles: **admin / member**.
- **Mọi member** tạo project + publish doc.
- **Admin**: mời/gỡ member, member directory, workspace settings (auth provider
  toggle, default access policy, branding).

**3. Project = folder tổ chức; browse theo doc-access.**
- Project CRUD: tạo/đổi tên/archive/xoá.
- Browse trong project (list/grid, sort, filter) **chỉ hiện doc user có quyền**
  (own/invited/general-access cho phép) — project roles defer v0.5, nên visibility
  bám doc-sharing, nhất quán với `restricted`.
- Move/copy doc giữa các project.

**4. Search = title + nội dung + comment, scope theo quyền.**
- Postgres full-text (tsvector) trên: title + text trích từ HTML/MD + body comment.
- Phạm vi: across-workspace hoặc trong project; **luôn lọc còn doc user truy cập
  được**.

**5. Notify reply = in-app + email; tới participant + owner.**
- Có reply trong thread → báo người đã tham gia thread đó + owner doc.
- Kênh: in-app (notification center) + email (SMTP — đã cần cho verify/invite).

---

### Happy path

1. Cài instance, mở lần đầu → first-run: tạo account admin + đặt tên workspace
   "Acme", bật GitHub+Google, branding logo.
2. Admin mời `dev@acme.com` (member). Dev sign up → vào workspace.
3. Dev tạo project "Billing", publish "Payment Spec" vào đó.
4. Reviewer comment; tác giả reply → reviewer nhận notify in-app + email.
5. Admin search "refund" → ra "Payment Spec" (khớp nội dung) + 1 doc khác mình có
   quyền; doc bị restricted mình không có quyền không hiện.

### Unhappy paths

- **Member không phải admin mở settings:** không thấy menu settings/member-manage;
  API từ chối.
- **Search khớp doc không có quyền:** loại khỏi kết quả (không lộ tồn tại).
- **Archive project:** doc trong đó ẩn khỏi browse mặc định, vẫn truy cập được qua
  link trực tiếp (assumption); unarchive để hiện lại.
- **Gỡ member:** member bị gỡ mất quyền workspace; doc họ own → cần transfer
  (transfer là v0.5) → v0 chặn gỡ nếu còn own doc, hoặc chuyển về admin (open
  question).

### Business rules

- Single workspace; first user = admin.
- Member tạo project/doc; admin quản settings/members.
- Browse + search luôn lọc theo doc-access của user.
- Notify chỉ tới participant thread + owner.

### Input validation

- Tên workspace/project: không rỗng, max 100 (assumption).
- Move/copy: doc + project đích thuộc cùng workspace.
- Search query: trim, min 1 ký tự.

### Permissions

- **admin:** member directory, invite/remove, workspace settings, provider toggle,
  branding.
- **member:** tạo/sửa project mình tạo, publish doc, browse/search trong quyền.
- Doc-level vẫn theo cụm sharing (member tạo doc → owner doc đó).

### Data impact

- `workspaces` (đã phác: name, slug, settings jsonb). v0 đúng 1 row.
- `workspace_members` (đã phác: workspaceId, userId, role admin/member).
- `projects` (đã phác: workspaceId, name, archivedAt).
- `docs.projectId` (đã có).
- Cần: index full-text (tsvector) trên docs (title + extracted text) + comments;
  bảng `notifications` (userId, type, refId, read, createdAt) cho in-app.
- Extracted-text: cần job trích text từ HTML/MD khi publish version (couples
  render-publish/versioning).

### Out of scope (v0 — defer)

- Multi-workspace/1-instance → v2.
- Project membership/roles override workspace → v0.5.
- Project default share settings → v0.5.
- Tags/labels, activity log/audit, trash+restore → v0.5.
- Favorites/pin, templates → v2.
- Transfer ownership (cần khi gỡ member) → v0.5; v0 xử tạm (open question).

### Decision rationale

- Single workspace: design doc chốt; tránh hẳn tenancy/switcher ở v0.
- Browse theo doc-access (không phải project membership): project roles defer nên
  không thể dựa vào chúng; bám doc-sharing giữ `restricted` đúng nghĩa.
- Search gồm content+comment: doc AI dày chữ, search title không đủ; Postgres FTS
  sẵn có, rẻ.
- Notify cả 2 kênh: người được gửi link thường không mở app thường xuyên → email
  cần để feedback loop khép; SMTP đã phải có cho verify/invite.

### Assumptions (cần xác nhận)

- Archive ẩn khỏi browse nhưng link trực tiếp vẫn vào được.
- Tên workspace/project max 100 ký tự.
- Notification có trạng thái read/unread; in-app là một center đơn giản.

### Open questions

- Gỡ member còn đang own doc: chặn, hay auto-chuyển owner về admin, hay buộc
  transfer trước? (transfer là v0.5) — cần chốt cách tạm cho v0.
- Email notify: cho phép user tắt (preference) ở v0 hay luôn gửi? Digest hay từng
  cái?
- Extracted-text cho search: trích lúc publish (lưu cột) hay tính khi index? Ảnh
  hưởng pipeline publish.
- anyone_in_workspace (cụm sharing) ở single-workspace v0 gần như = mọi member —
  giữ làm tier riêng hay gộp? (đã nêu ở sharing).

### Complexity signal: **medium**

Nhiều mặt nhưng mỗi mặt vừa phải; phần đáng lưu ý: FTS pipeline (extract text),
notification system (in-app + email), và quan hệ browse↔doc-access.

### Cross-cluster dependencies

- **auth:** first-run admin; member = user; SMTP cho notify/verify/invite.
- **sharing-permissions:** browse/search lọc theo general-access + invite;
  anyone_in_workspace; admin quản member ≈ nguồn member directory.
- **render-publish / versioning-diff:** extract-text khi publish version cho search.
- **annotation-core:** notify reply dựa trên thread participant.
- **self-host:** SMTP config, branding, first-run, storage.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW. Doc = spec anchord thật.

**Project browser + search** `[N]` ← S-003 (browse chỉ doc có quyền) /S-005 (search
title+content+comment) · C-009 (default project per user)
```
┌──────────────────────────────────────────────────────────────────┐
│ ⚓ microvn /     [ Tìm: "block_id" … ]          [+ New doc]   ⬤HG  │
├────────────┬───────────────────────────────────────────────────────┤
│ PROJECTS   │  Hoàng's docs (default)        ⬤anyone-in-workspace    │
│ ▸Hoàng's◀  │  ┌────────────────┐ ┌────────────────┐                │
│  (default) │  │annotation-core │ │render-publish  │                │
│  + New     │  │[HTML] v2 ·22 AS│ │[HTML] v1 ·13 AS│                │
│ FILTER     │  │⬤link 💬3 ▣1     │ │restricted 💬0   │                │
│  All docs  │  └────────────────┘ └────────────────┘                │
│  Shared    │   (chỉ doc mình có quyền; restricted người khác ẩn;    │
│  Has detach│    grid 3→2→1 cột theo width)                          │
└────────────┴───────────────────────────────────────────────────────┘
```

**Notifications** `[N]` ← S-006 (reply → participant + owner, in-app + email)
```
┌─────────────────────────────────────────────┐
│ 🔔 Notifications                             │
│ ⬤ Lan replied on annotation-core · "ok 48h" 2h│
│ ⬤ An commented · S-002 image-region        5h│
│ ▣ 1 annotation detached on render-publish  1d│ ← từ re-anchor
└─────────────────────────────────────────────┘
```
