# Spec: auth

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

Đăng ký/đăng nhập đa phương thức (email+password, GitHub, Google), phiên DB-backed,
operator bật/tắt provider qua config. Auth = *cách* đăng nhập, tách khỏi roles/share
(*cái* phân quyền). Dùng thư viện better-auth (tự quản schema auth).

## Data Model

- **better-auth tự quản:** `user`, `session`, `account`, `verification`.
- Bảng app (`workspaces`, `docs`, `annotations`, `comments`, `doc_members`,
  `api_tokens`…) tham chiếu `user.id`.
- Pending invite (`doc_members` ở `sharing-permissions`) được pick up theo email
  lúc sign up.

## Stories

### S-001: Sign up / sign in with email + password (P0)

**Description:** Là người dùng, tôi đăng ký và đăng nhập bằng email + mật khẩu; có
phiên đăng nhập revoke được.
**Source:** docs/explore/auth.md#quyết-định (mục 2 method set), #business-rules.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (dự kiến cấu hình better-auth + `src/auth/*`)
- `autonomous:` true
- `verify:` đăng ký email+pw → đăng nhập → có phiên; logout → phiên mất.

**Acceptance Scenarios:**

AS-001: Đăng ký rồi đăng nhập email+password
- **Given:** provider email+password đang bật, SMTP đã cấu hình
- **When:** đăng ký bằng email+mật khẩu, xác thực email, rồi đăng nhập
- **Then:** tài khoản active; có phiên đăng nhập (cookie); logout xoá phiên
- **Data:** email mới + mật khẩu ≥ 8 ký tự

AS-002: Sai mật khẩu bị từ chối + rate-limit
- **Given:** một account email+password tồn tại
- **When:** đăng nhập sai mật khẩu nhiều lần liên tiếp
- **Then:** từ chối; sau ngưỡng thất bại → tạm hạn chế thử lại
- **Data:** sai mật khẩu lặp lại

### S-002: Sign in with OAuth (GitHub / Google) (P0)

**Description:** Là người dùng, tôi đăng nhập qua GitHub hoặc Google và có phiên.
**Source:** docs/explore/auth.md#quyết-định (mục 2), #happy-path.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (OAuth provider config better-auth)
- `autonomous:` checkpoint
- `verify:` "Continue with GitHub" → quay về có phiên; provider tắt → nút không hiện.

**Acceptance Scenarios:**

AS-003: Đăng nhập GitHub tạo phiên
- **Given:** provider GitHub đang bật
- **When:** người dùng bấm "Continue with GitHub", hoàn tất OAuth
- **Then:** tạo (hoặc khớp) account, email coi như verified; có phiên đăng nhập
- **Data:** tài khoản GitHub hợp lệ

AS-004: OAuth callback lỗi/từ chối không tạo phiên
- **Given:** người dùng bắt đầu OAuth nhưng từ chối cấp quyền / callback lỗi
- **When:** quay về app
- **Then:** không tạo phiên; quay lại sign-in với thông báo lỗi
- **Data:** OAuth bị huỷ

### S-003: Auto-link providers by verified email (P1)

**Description:** Là người dùng đã có account, khi tôi đăng nhập bằng phương thức
khác cùng email đã verified, hệ thống gộp vào cùng một account.
**Source:** docs/explore/auth.md#quyết-định (mục 3 account linking).

**Execution:**
- `depends_on:` S-001, S-002
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` checkpoint
- `verify:` account GitHub (email verified) rồi đăng nhập Google cùng email → cùng account.

**Acceptance Scenarios:**

AS-005: Auto-link khi email đã verified
- **Given:** account đã tồn tại với email đã verified (vd qua GitHub)
- **When:** người dùng đăng nhập Google cùng email đã verified
- **Then:** gộp vào cùng account (không tạo account trùng)
- **Data:** cùng email, cả hai verified

AS-006: KHÔNG auto-link khi email chưa verified
- **Given:** một account có email chưa verified
- **When:** một phương thức khác đăng nhập với cùng email (chưa verified)
- **Then:** KHÔNG auto-link (chống chiếm tài khoản); giữ account riêng cho tới khi verify
- **Data:** email chưa verified

AS-010: OAuth trả email_verified=false không auto-link [harden H3]
- **Given:** đã có account verified cho `victim@x.com`
- **When:** đăng nhập OAuth trả về `victim@x.com` nhưng provider KHÔNG khẳng định
  `email_verified===true` (thiếu hoặc false)
- **Then:** KHÔNG auto-link; định tuyến sang xác nhận "link account" cần chứng minh
  quyền sở hữu account cũ
- **Data:** provider email_verified=false

### S-004: Operator toggles auth providers (P1)

**Description:** Là operator self-host, tôi bật/tắt từng provider qua config; UI chỉ
hiện provider đang bật.
**Source:** docs/explore/auth.md#quyết-định (mục 4 toggle).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (config/env)
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: Provider tắt thì không hiện và không nhận callback
- **Given:** operator tắt Google trong config
- **When:** người dùng mở trang sign-in
- **Then:** không thấy nút Google; nếu cố gọi callback Google → bị từ chối
- **Data:** Google off, GitHub on

### S-005: Activate pending invite on sign up (P0)

**Description:** Là người được mời (cụm sharing) chưa có account, khi tôi đăng ký
bằng đúng email được mời (đã verified), tôi nhận role đã mời.
**Source:** docs/explore/auth.md#cross-cluster (sharing pending invite).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (phối hợp sharing-permissions)
- `autonomous:` true
- `verify:` tạo pending invite editor cho email X → sign up X (verified) → có role editor.

**Acceptance Scenarios:**

AS-008: Sign up bằng email được mời kích hoạt role
- **Given:** có pending invite (email `bob@x.com`, role editor) từ cụm sharing
- **When:** Bob đăng ký bằng `bob@x.com` và email được verified
- **Then:** lời mời kích hoạt; Bob có role editor trên doc tương ứng
- **Data:** email khớp pending invite

AS-009: Email khác không kích hoạt invite của email kia
- **Given:** pending invite cho `bob@x.com`
- **When:** người khác đăng ký bằng `eve@x.com`
- **Then:** không nhận role nào của invite dành cho `bob@x.com`
- **Data:** email không khớp

AS-011: SMTP lỗi lúc runtime không làm kẹt vĩnh viễn [harden H6]
- **Given:** SMTP cấu hình OK lúc boot nhưng provider lỗi/rate-limit lúc gửi
- **When:** một verify/invite được gửi và send thất bại
- **Then:** mail vào queue + retry; thất bại hiện trạng thái cho operator; pending
  invite vẫn chấp nhận được qua link in-app/shareable không phụ thuộc email tới
- **Data:** SMTP trả 5xx lúc runtime

## Constraints & Invariants

- C-001: Phiên DB-backed (cookie httpOnly), revoke được; logout xoá phiên. (AS-001)
- C-002 [harden H3]: Email từ OAuth CHỈ coi verified khi provider khẳng định rõ
  `email_verified === true`; thiếu/false → không coi verified. email+password phải
  verify trước khi auto-link. (AS-003, AS-006, AS-010)
- C-003: Auto-link chỉ khi email đã verified (chống account takeover). (AS-005, AS-006)
- C-004: Provider bật/tắt qua config; UI chỉ hiện provider đang bật; provider tắt từ
  chối callback. (AS-007)
- C-005: Pending invite kích hoạt khi account của đúng email đó tồn tại + verified. (AS-008, AS-009)
- C-006: Mật khẩu tối thiểu 8 ký tự (NIST-style, không quy tắc cứng nhắc); hash bằng
  better-auth. (AS-001)
- C-007: Đăng nhập có rate-limit chống brute-force. (AS-002)
- C-008: SMTP bắt buộc — app không khởi động nếu thiếu cấu hình SMTP (như APP_SECRET);
  do đó email verify luôn hoạt động, không có chế độ no-verify. (AS-001)
- C-009 [harden H6]: SMTP bắt buộc lúc boot KHÁC với gửi được lúc runtime — mọi
  outbound mail enqueue + retry + dead-letter + trạng thái "gửi lỗi" cho operator;
  pending invite kèm link chấp nhận (in-app/shareable) hoạt động KHÔNG phụ thuộc
  email có tới hay không. (AS-011)
  _(Token hardening hashed/scope/revoke → `mcp-roundtrip` C-008.)_

## Linked Fields

- **pending invite (email→role)** — produced bởi `sharing-permissions:S-003` (AS-008).
  Consumed bởi auth:S-005 (AS-008) lúc sign up để gán role. ✔ pick-up theo email verified.
- **`user.id`** — produced bởi auth (better-auth user). Consumed bởi mọi bảng app
  (workspace_members, docs.published_by, annotations, api_tokens…). ✔ là khoá danh
  tính chung toàn hệ.

## UI Notes

Từ `docs/explore/auth.md` §UI sketches. Greenfield → `[N]`. Component names only.
Dark-operator (`DESIGN.md`). Precedence: AS > Tree.

- `SignInCard` `[N]`
  - `EmailField` · `PasswordField` · `SignInButton`
  - `OAuthButton` GitHub · `OAuthButton` Google *(chỉ render provider operator bật — S-004)*
- `FirstRunSetup` `[N]` *(2-pane; **stacked** ≤760; chỉ chạy lần đầu)*
  - `WorkspaceNameField` · `AdminEmailField`
  - `ProviderToggleList` → `ProviderToggle` *(email+pw / GitHub / Google)*
  - `SmtpStatus` *(bắt buộc — configured ✓ / chặn nếu thiếu, C-008)*
  - `CreateWorkspaceButton`

## What Already Exists

### System Impact & Technical Risks

- Repo greenfield. better-auth tự quản schema auth → bảng `users` phác cũ nhường cho nó.
- Cross-spec: `sharing-permissions` tạo pending invite; `mcp-roundtrip` phát API
  token gắn user; `workspace-project` first-run admin = user đầu tiên; `self-host`
  cấp APP_SECRET (phiên) + provider env + SMTP.
- Risk (sensitive): OAuth (external identity) + auto-link (account-takeover surface)
  → đánh `checkpoint`; sai sót ở đây là rủi ro bảo mật/chiếm tài khoản.

## Not in Scope

- Magic link → v0.5.
- GitLab OAuth → v0.5.
- OIDC/SAML SSO (cắm IdP riêng) → v0.5 (better-auth SSO plugin).
- 2FA / passkey → v2.
- OAuth 2.1 Provider cho MCP agent → `mcp-roundtrip` quyết định (v0 dùng API token).
- First-run instance admin (tạo workspace) → `workspace-project`.

## Gaps

- GAP-001 (status: resolved → C-008): SMTP **bắt buộc** — app không khởi động nếu
  chưa cấu hình SMTP. Nên email verify luôn gửi được; không có chế độ degrade.
  (Chốt 2026-06-07; đảo lại "SMTP optional" của explore — `self-host` phải cập nhật:
  SMTP là config bắt buộc lúc boot như APP_SECRET.)
- GAP-002 (status: deferred): ngưỡng rate-limit đăng nhập (số lần / thời gian khoá)
  — chốt lúc build. Source: "Rate-limit đăng nhập bật (ngưỡng chốt lúc build)".

## Clarifications — 2026-06-07

- **better-auth thay vì tự ráp:** tổ hợp email+pw/OAuth/(SSO sau) tự viết dễ sai bảo
  mật; better-auth là lựa chọn 2026 cho TS, hợp Bun/Elysia/Drizzle, DB session.
- **DB session thay vì JWT:** cần revoke/logout/cấm phiên cho self-host.
- **Method v0 = email+pw + GitHub + Google;** magic link & GitLab dời v0.5; Google
  kéo lên v0.
- **Auto-link chỉ khi verified:** cân bằng liền mạch vs chống account takeover.
- **SMTP bắt buộc (đảo lại explore):** app không khởi động nếu thiếu SMTP → email
  verify/invite/notify luôn hoạt động, bỏ mọi logic degrade. Ảnh hưởng `self-host`:
  SMTP_* thành config bắt buộc lúc boot.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/auth.md) | -- |
| 2026-06-07 | GAP-001 resolved → C-008 (SMTP bắt buộc, không degrade) | -- |
| 2026-06-07 | /mf-challenge harden: C-002 (auto-link cần email_verified) + AS-010; C-009 + AS-011 (SMTP runtime retry/dead-letter, invite accept-link) | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
