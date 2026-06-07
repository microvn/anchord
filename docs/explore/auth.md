## Explore: auth

_2026-06-07_

**Feature:** Đăng ký/đăng nhập đa phương thức, operator bật/tắt provider qua
config. Auth = *cách* đăng nhập (tách khỏi roles/share = *cái* phân quyền sau đó).

**Trigger:** Người dùng đăng ký/đăng nhập; hoặc nhận pending-invite (cụm sharing)
rồi sign up bằng email được mời.

**UI expectation:** Trang sign-in/sign-up với nút email+pw + nút GitHub + Google;
chỉ hiện provider nào operator bật. Toàn bộ **[N] NEW**.

---

### Quyết định (đã chốt trong phiên explore, research-backed)

**1. Thư viện = better-auth.**
- Tích hợp chính thức Elysia + Bun + Drizzle adapter (trúng cả stack).
- DB session (cookie httpOnly), revoke được — hợp self-host (logout/cấm phiên).
- Email+pw + OAuth built-in + SSO plugin (OIDC/SAML) cho v0.5; operator toggle
  provider qua config.
- Lucia đã maintenance mode (loại); Auth.js thiên Next (loại).
- Bonus: better-auth v1.5 có OAuth 2.1 Provider plugin hỗ trợ **MCP agent** → dùng
  cho auth agent ở cụm mcp-roundtrip.

**2. Method set v0 = email+password, GitHub OAuth, Google OAuth.**
- **Magic link DỜI xuống v0.5** (design doc xếp v0, đã trim).
- Google KÉO LÊN v0 (design doc xếp v0.5).
- v0.5+: magic link, GitLab, OIDC/SAML SSO (qua SSO plugin).

**3. Account linking = auto-link nếu email đã verify.**
- Các provider cùng email *đã verified* → gộp 1 account (liền mạch). CHỈ link khi
  email verified (better-auth có setting) — tránh lỗ hổng chiếm tài khoản qua email
  chưa xác thực.

**4. Operator toggle provider qua config.**
- Bật/tắt từng provider (email/GitHub/Google) bằng env/config; UI chỉ hiện provider
  đang bật.

---

### Happy path

1. User mở /sign-in, bấm "Continue with GitHub" → OAuth → quay về, better-auth tạo
   user + session cookie → vào app.
2. User khác đăng ký email+pw → nhận email verify → bấm link → account active.
3. User có pending-invite (email `bob@x.com`, role editor) sign up bằng đúng email
   đó → invite kích hoạt, Bob vào doc với role editor (cụm sharing).
4. User trước đó dùng GitHub, nay đăng nhập Google cùng email đã verified → auto
   link vào cùng account.

### Unhappy paths

- **Email chưa verify cố link provider khác:** không auto-link (chống chiếm tài
  khoản); buộc verify hoặc giữ account riêng.
- **Provider bị operator tắt:** nút không hiện; nếu cố gọi callback → từ chối.
- **OAuth callback lỗi/từ chối:** quay về sign-in với thông báo lỗi, không tạo
  phiên.
- **Đăng nhập sai mật khẩu nhiều lần:** rate-limit (better-auth hỗ trợ) → tạm khoá
  thử lại (assumption ngưỡng).

### Business rules

- Session DB-backed, cookie httpOnly; logout xoá session.
- Email từ OAuth provider coi như verified (provider đã xác thực); email+pw phải
  verify trước khi auto-link.
- Pending-invite khớp theo email lúc account email đó trở nên tồn tại + verified.

### Input validation

- Email đúng format, unique theo account.
- Password: min độ dài + chính sách (assumption: min 8, không yêu cầu ký tự đặc
  biệt cứng nhắc — theo NIST). Hash bằng better-auth (scrypt/argon2 mặc định).

### Permissions

- Auth không có "role" — chỉ xác thực danh tính. Phân quyền là cụm sharing +
  workspace (workspace admin/member; doc roles).
- **First-run / instance admin** (self-host): user đầu tiên thành admin workspace
  → thuộc cụm **workspace-project**, ghi nhận coupling.

### Data impact

- **better-auth tự quản schema auth:** `user`, `session`, `account`,
  `verification`. → Bảng `users` tôi phác ban đầu NHƯỜNG cho better-auth.
- Bảng app (`workspaces`, `workspace_members`, `docs`, `annotations`, `comments`)
  tham chiếu `user.id` của better-auth.
- Pending-invite (bảng `doc_members`/`doc_shares` ở cụm sharing) phải được auth
  pick up lúc sign up.

### Out of scope (v0 — defer)

- Magic link → v0.5.
- GitLab OAuth → v0.5.
- OIDC/SAML SSO (cắm IdP riêng) → v0.5, qua better-auth SSO plugin (lợi thế
  self-host cốt lõi nhưng không phải v0).
- 2FA/passkey → v2 (better-auth có plugin sẵn khi cần).
- OAuth 2.1 Provider cho MCP agent → cụm mcp-roundtrip quyết định có dùng không.

### Decision rationale

- better-auth thay vì tự ráp: tổ hợp email+pw/OAuth/(SSO sau) tự viết dễ sai bảo
  mật; better-auth là lựa chọn 2026 cho TS, hợp Bun/Elysia/Drizzle, DB session.
- DB session thay vì JWT: cần revoke/logout/cấm phiên cho self-host; JWT khó thu
  hồi.
- Auto-link chỉ khi verified: cân bằng liền mạch vs chống account takeover.
- Trim magic link khỏi v0: giảm bề mặt + phụ thuộc SMTP sớm; email+pw + 2 OAuth đã
  đủ vào cửa.

### Assumptions (cần xác nhận)

- Yêu cầu verify email cho đăng ký email+pw; email OAuth coi như verified.
- Password min 8 ký tự (NIST-style, không quy tắc cứng nhắc).
- Rate-limit đăng nhập bật (ngưỡng chốt lúc build).

### Open questions

- **SMTP/email sending:** verify email + invite email + notify reply đều cần gửi
  mail. Operator self-host cấu hình SMTP thế nào, provider mặc định gì (hay tắt
  được)? → couples **self-host** + **workspace-project (notify)**. Magic link đã
  trim nên áp lực email giảm, nhưng verify + invite vẫn cần.
- Nếu operator tắt hết OAuth và chưa cấu hình SMTP → email verify không gửi được;
  có cần chế độ "không cần verify" cho instance nội bộ?
- First-run admin: user đầu tiên auto-thành instance admin? → workspace cluster.

### Complexity signal: **low-medium**

better-auth gánh phần nặng. Phức tạp còn lại: cấu hình provider toggle, reconcile
schema better-auth với bảng app, và pick-up pending-invite. SMTP là ẩn số phụ thuộc
self-host.

### Cross-cluster dependencies

- **sharing-permissions:** pending-invite kích hoạt lúc sign up; password hashing
  (link password) có thể tái dùng tiện ích better-auth.
- **workspace-project:** first-run instance admin; user → workspace member.
- **mcp-roundtrip:** OAuth 2.1 Provider / token cho agent publish-pull.
- **self-host:** cấu hình SMTP + provider env; secret APP_SECRET cho session.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW.

**Sign in + First-run setup** `[N]` ← S-001 (email+pw) /S-002 (GitHub/Google)
/S-004 (provider toggle) · workspace-project S-001 (first-run admin) · self-host
(SMTP bắt buộc C-008)
```
┌─────────────────────────────┬─────────────────────────────┐
│ Sign in                     │ First-run setup             │
│ anchord · self-hosted       │ User đầu = instance admin    │
│ Email   [ you@team.com    ] │ Workspace [ microvn       ]  │
│ Password[ ········        ] │ Admin email[ hoang@…      ]  │
│        [    Sign in    ]    │ Email+password      ●──○ on  │
│ ─────── hoặc ───────        │ GitHub OAuth        ●──○ on  │ ←S-004
│ [ Continue with GitHub  ]   │ Google OAuth        ●──○ on  │
│ [ Continue with Google  ]   │ SMTP (bắt buộc)  configured✓ │ ←self-host
│                             │     [ Create workspace ]     │
└─────────────────────────────┴─────────────────────────────┘ (≤760: stacked)
```
