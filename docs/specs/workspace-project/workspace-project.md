# Spec: workspace-project

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

Tầng tổ chức Workspace → Project → Doc cho v0 single-workspace (instance là một
workspace). First-run tạo workspace + admin; member tạo project/doc; browse và
search lọc theo quyền truy cập doc; notify khi có reply qua in-app + email.

## Data Model

- **workspaces**: `id`, `name`, `slug`, `settings` (auth providers, default access,
  branding). v0 đúng 1 row.
- **workspace_members**: `workspace_id`, `user_id`, `role` (admin | member).
- **projects**: `workspace_id`, `name`, `archived_at`.
- **docs.project_id** (định nghĩa ở `render-publish`).
- **notifications**: `user_id`, `type`, `ref_id`, `read`, `created_at` (in-app).
- Full-text index trên docs (title + text trích từ HTML/MD) + comment bodies.

## Stories

### S-001: First-run setup creates workspace + admin (P0)

**Description:** Là người cài instance, lần mở đầu tiên tôi tạo tài khoản admin và
workspace; người đăng ký sau là member thường.
**Source:** docs/explore/workspace-project.md#quyết-định (mục 1 single workspace).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (first-run wizard + workspace bootstrap)
- `autonomous:` true
- `verify:` instance mới → first-run tạo admin + workspace; user thứ hai là member.

**Acceptance Scenarios:**

AS-001: User đầu tiên thành instance admin + tạo workspace
- **Given:** instance mới, chưa có workspace
- **When:** người đầu tiên hoàn tất first-run (đặt tên workspace, branding, bật provider)
- **Then:** tạo workspace + tài khoản đó là admin
- **Data:** tên "Acme", bật GitHub+Google

AS-002: Người đăng ký sau là member thường
- **Given:** workspace đã tồn tại với 1 admin
- **When:** người thứ hai đăng ký/được mời vào
- **Then:** họ là member (không phải admin)
- **Data:** user thứ hai

### S-002: Manage workspace members (P1)

**Description:** Là admin, tôi mời và gỡ member; member không quản lý được thành viên.
**Source:** docs/explore/workspace-project.md#quyết-định (mục 2 vai trò).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-003: Admin mời member
- **Given:** admin mở member directory
- **When:** mời `dev@acme.com` làm member
- **Then:** người đó vào workspace với role member
- **Data:** email member

AS-004: Member không quản lý được thành viên
- **Given:** user role member
- **When:** họ cố mở quản lý member / settings workspace
- **Then:** không được phép (chỉ admin)
- **Data:** member cố mời người

AS-012: Gỡ member không làm mất doc của họ
- **Given:** member M own một doc trong project (general_access = anyone_in_workspace)
- **When:** admin gỡ M khỏi workspace
- **Then:** doc vẫn ở trong project/workspace, member khác vẫn truy cập theo
  general_access; quản lý share của doc mất owner do admin đảm nhiệm (fallback)
- **Data:** M own 1 doc anyone_in_workspace

### S-003: Create & browse projects (P0)

**Description:** Là member, tôi tạo/đổi tên/archive/xoá project và duyệt doc trong
project — chỉ thấy doc tôi có quyền.
**Source:** docs/explore/workspace-project.md#quyết-định (mục 3 project).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true
- `verify:` tạo project, publish doc vào; user khác không có quyền doc đó không thấy nó trong browse.

**Acceptance Scenarios:**

AS-005: Member tạo project và publish doc vào
- **Given:** member đã đăng nhập
- **When:** tạo project "Billing", publish một doc vào đó
- **Then:** project + doc xuất hiện; member là owner doc
- **Data:** project "Billing"

AS-006: Browse chỉ hiện doc người dùng có quyền
- **Given:** project "Billing" có doc A (restricted, không mời người X) và doc B
  (anyone_in_workspace)
- **When:** member X mở project "Billing"
- **Then:** thấy doc B, KHÔNG thấy doc A
- **Data:** X không có quyền doc A

AS-014: Mỗi tài khoản có một default project tự tạo
- **Given:** một user trở thành member của workspace
- **When:** tài khoản được tạo/gia nhập
- **Then:** một default project được tự tạo cho user đó (nơi MCP đưa doc vào nếu
  thiếu projectId — `mcp-roundtrip:AS-003`)
- **Data:** user mới → default project "<tên user>'s docs"

AS-007: Archive project ẩn khỏi browse
- **Given:** project có doc
- **When:** member archive project
- **Then:** project ẩn khỏi browse mặc định; doc vẫn truy cập qua link trực tiếp;
  unarchive để hiện lại
- **Data:** project bị archive

### S-004: Move or copy a doc between projects (P1)

**Description:** Là người có quyền, tôi chuyển hoặc nhân bản một doc sang project
khác trong cùng workspace.
**Source:** docs/explore/workspace-project.md#quyết-định (mục 3 move/copy).

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-008: Chuyển doc sang project khác
- **Given:** doc đang ở project "Billing"
- **When:** chuyển sang project "Payments" (cùng workspace)
- **Then:** doc thuộc "Payments"; truy cập/sharing/version/annotation của doc không đổi
- **Data:** Billing → Payments

AS-013: Nhân bản (copy) doc sang project khác
- **Given:** doc ở project "Billing" đang ở version 3
- **When:** copy sang project "Payments"
- **Then:** tạo doc MỚI ở "Payments" với slug mới, nội dung = version hiện hành làm
  version 1; KHÔNG copy annotation/comment (bản sạch); doc gốc giữ nguyên
- **Data:** copy doc 3-version → doc mới 1-version, không annotation

### S-005: Search across accessible docs (P0)

**Description:** Là người dùng, tôi tìm theo tiêu đề, nội dung và comment; chỉ ra
kết quả trong các doc tôi có quyền.
**Source:** docs/explore/workspace-project.md#quyết-định (mục 4 search).

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` unknown (FTS Postgres + extract-text pipeline)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Search khớp nội dung + comment, lọc theo quyền
- **Given:** doc "Payment Spec" (mình có quyền) chứa từ "refund" trong nội dung; doc
  khác chứa "refund" nhưng mình không có quyền
- **When:** search "refund" (toàn workspace)
- **Then:** ra "Payment Spec" (khớp nội dung/comment); KHÔNG ra doc mình không có
  quyền, kể cả khi từ khoá khớp trong **comment** của doc restricted (không lộ snippet)
- **Data:** "refund" trong content + 1 doc restricted ngoài quyền có comment chứa "refund"

AS-010: Search trong phạm vi một project
- **Given:** đang ở project "Billing"
- **When:** search "invoice" trong project
- **Then:** chỉ ra doc khớp trong "Billing" mà mình có quyền
- **Data:** scope = project

### S-006: Notify on reply (P1)

**Description:** Là người tham gia thread (hoặc owner doc), tôi được báo khi có reply.
**Source:** docs/explore/workspace-project.md#quyết-định (mục 5 notify).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (phối hợp annotation-core + SMTP)
- `autonomous:` true

**Acceptance Scenarios:**

AS-011: Reply báo participant + owner qua in-app + email
- **Given:** một thread có người A, B tham gia; doc owner là C
- **When:** A reply trong thread
- **Then:** B và C nhận notify (in-app + email); người tự reply (A) không tự nhận
- **Data:** thread {A,B}, owner C

## Constraints & Invariants

- C-001: v0 single workspace = instance; user đầu tiên = admin; người sau = member. (AS-001, AS-002)
- C-002: Member tạo project/doc; chỉ admin quản settings/members. (AS-003, AS-004, AS-005)
- C-003: Browse và search luôn lọc còn doc người dùng có quyền (không lộ doc ngoài
  quyền). Search join với doc-access TRƯỚC khi trả: không trả title/content/**snippet
  comment** từ doc ngoài quyền; "không quyền" và "không tồn tại" trả kết quả không
  phân biệt được (tránh rò rỉ existence). [harden H2] (AS-006, AS-009)
- C-004: Notify reply tới participant thread + owner doc, qua in-app + email; người tự reply không tự nhận. (AS-011)
- C-005: Archive ẩn project khỏi browse; doc vẫn vào được qua link trực tiếp; unarchive để hiện. (AS-007)
- C-006: Search index gồm title + text trích từ HTML/MD + body comment. (AS-009)
- C-007: Doc thuộc project/workspace, không thuộc cá nhân — gỡ member không xoá/ẩn
  doc; truy cập tiếp tục theo general_access; share của doc mất owner do admin lo. (AS-012)
- C-008: Copy tạo doc mới (slug mới, version hiện hành làm v1), KHÔNG copy
  annotation/comment; move giữ nguyên doc (slug/version/annotation). (AS-008, AS-013)
- C-009: Mỗi tài khoản có một default project tự tạo khi gia nhập workspace; là nơi
  MCP đưa doc vào nếu thiếu projectId (`mcp-roundtrip`). (AS-014)

## Linked Fields

- **doc-access (general_access + invite)** — produced bởi `sharing-permissions`.
  Consumed bởi workspace-project:S-003/S-005 (AS-006, AS-009) để lọc browse/search.
  ✔ enforcement định nghĩa ở sharing; cụm này áp khi liệt kê.
- **thread participants + doc owner** — produced bởi `annotation-core` (thread) +
  doc owner (sharing). Consumed bởi S-006 (AS-011) để chọn người nhận notify. ✔.
- **extracted text của version** — produced bởi pipeline publish (`render-publish`/
  `versioning-diff`). Consumed bởi S-005 (AS-009) để index FTS. ✘ pipeline trích
  text chưa được pin ở spec render-publish → GAP-003.

## UI Notes

Từ `docs/explore/workspace-project.md` §UI sketches. Greenfield → `[N]`. Component
names only. Dark-operator (`DESIGN.md`). Precedence: AS > Tree.

- `ProjectBrowser` `[N]`
  - `BrowserTopBar`: workspaceName · `SearchField` *(title+content+comment)* · `NewDocButton` · `UserAvatar`
  - `ProjectSidebar`: `ProjectList` → `ProjectItem` *(default project pinned, C-009)* · `+ New project` · `FilterList` (All / Shared / Has detached)
  - `DocGrid` *(3→2→1 cột theo width)* → `DocCard`: title · `FormatBadge` · versionLabel · `AccessIndicator` · commentCount · `DetachedBadge`
  - `GridListToggle`
  - *Mobile: `ProjectSidebar` → drawer.*
- `NotificationCenter` `[N]` → `NotificationItem` *(reply / comment / detached; in-app)*

## What Already Exists

### System Impact & Technical Risks

- Repo greenfield. Cross-spec nặng: dựa `sharing-permissions` (lọc quyền),
  `annotation-core` (participants), `auth` (admin/member, SMTP), `render-publish`/
  `versioning-diff` (extract-text).
- Risk: FTS cần text trích từ HTML/MD — pipeline trích nằm ở publish, chưa pin (GAP-003).

## Not in Scope

- Multi-workspace / 1 instance → v2.
- Project membership/roles override workspace → v0.5.
- Project default share settings → v0.5.
- Tags/labels, activity log/audit, trash+restore → v0.5.
- Favorites/pin, templates → v2.
- Transfer ownership → v0.5.

## Gaps

- GAP-001 (status: resolved → AS-012, C-007): gỡ member không chặn; doc thuộc
  project/workspace nên ở lại, truy cập theo general_access; share mất owner do admin
  lo. (Chốt 2026-06-07.)
- GAP-002 (status: open): email notify — cho tắt (preference) ở v0 hay luôn gửi?
  digest hay từng cái? Source: "Email notify: cho phép user tắt … digest hay từng cái".
- GAP-003 (status: open): pipeline trích text cho search — trích lúc publish (lưu
  cột) hay tính khi index? Pin ở `render-publish`/`versioning-diff`. Source:
  "Extracted-text … trích lúc publish hay tính khi index".

## Clarifications — 2026-06-07

- **Single workspace:** design doc chốt; tránh tenancy/switcher ở v0.
- **Browse theo doc-access (không phải project membership):** project roles defer
  v0.5 nên bám doc-sharing, giữ restricted đúng nghĩa.
- **Search gồm content + comment:** doc AI dày chữ, search title không đủ; Postgres FTS rẻ.
- **Notify cả hai kênh:** người được gửi link ít mở app → email cần để khép feedback
  loop. SMTP đã bắt buộc (cụm auth) nên luôn gửi được.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/workspace-project.md) | -- |
| 2026-06-07 | GAP-001 resolved → AS-012 + C-007 (gỡ member không mất doc) | -- |
| 2026-06-07 | Copy doc đưa lại v0 → AS-013 + C-008 (không trim copy) | -- |
| 2026-06-07 | AS-014 + C-009 (default project per tài khoản, cho mcp-roundtrip) | -- |
| 2026-06-07 | /mf-challenge harden H2: C-003 + AS-009 (search không lộ snippet comment doc ngoài quyền + existence) | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
