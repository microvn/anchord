# Spec: auth-ui

**Created:** 2026-06-09
**Last updated:** 2026-06-09
**Status:** Draft

## Overview

The frontend for getting INTO anchord, beyond what `web-core` already built (sign-in with
email+password, sign-out, route guard). This slice covers: **sign-up + email verification**,
**OAuth sign-in** (GitHub / Google — only the providers the operator enabled via ENV), and
**accepting an invite** (a per-doc invite link → the invited role). FE sibling of the backend
`auth` feature (`auth/auth.md`), consuming the now-wired email-verify / invite-on-verify /
accept-link backend (commit 336078c).

No first-run setup wizard: auth providers and branding are ENV-only (a provider with no ENV
creds is simply not offered), and workspace creation is automatic, not an auth-flow screen.
Magic-link is out of scope (deferred v0.5, not wired in the backend).

## Data Model

No persistent data — a client. Reads the server session (web-core); holds transient form
state only (no tokens client-side).

## Stories

### S-001: Sign up and verify email (P0)

**Description:** As a new user, I sign up with email and password, am told to verify my email,
and can sign in only after verifying.
**Source:** auth S-001 (AS-001 sign-up + verify), AS-012 (mail delivered); docs/explore/auth.md#sign-up.

**Execution:**
- `depends_on:` none (builds on web-core)
- `parallel_safe:` false
- `files:` unknown (`apps/web/` sign-up screen + verify-sent / verify-landing states)
- `autonomous:` true
- `verify:` sign up → "check your inbox"; before verifying, sign-in is refused with a "verify first" message; after verifying, sign-in works.

**Acceptance Scenarios:**

AS-001: Signing up shows a "check your inbox" state
- **Given:** I am not registered
- **When:** I sign up with a valid email and a password of at least 8 characters
- **Then:** my account is created and I see a "verify your email" confirmation (with a resend option)
- **Data:** new email, password ≥ 8 chars

AS-002: Signing in before verifying is refused with a verify-first message
- **Given:** I signed up but have not verified my email
- **When:** I try to sign in
- **Then:** I am refused with a clear "verify your email first" message (not a generic wrong-password error)
- **Data:** unverified account

AS-003: Opening a valid verification link verifies the account
- **Given:** I hold a valid verification link
- **When:** I open it
- **Then:** my account becomes verified and I can proceed to sign in / the app
- **Data:** valid verification token

AS-004: An expired or invalid verification link shows a recoverable error
- **Given:** I hold an expired or tampered verification link
- **When:** I open it
- **Then:** I see an "expired or invalid link" state with a way to resend, not a crash
- **Data:** expired/invalid token

AS-005: Signing up with an already-registered email is refused
- **Given:** an account already exists for `taken@acme.com`
- **When:** I sign up with `taken@acme.com`
- **Then:** I see an "email already in use" error and stay on the sign-up screen
- **Data:** taken email

### S-002: Sign in with an enabled OAuth provider (P1)

**Description:** As a user, I sign in with GitHub or Google; only the providers the operator
enabled (ENV creds present) are offered; a denied or failed callback creates no session and shows an error.
**Source:** auth S-002 (AS-003 GitHub session, AS-004 denied callback), S-004 (AS-007 disabled provider not shown).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (`apps/web/` OAuth buttons + callback error handling)
- `autonomous:` true

**Acceptance Scenarios:**

AS-006: An enabled OAuth provider signs me in
- **Given:** GitHub is an enabled provider (ENV creds present)
- **When:** I click "Continue with GitHub" and complete the grant
- **Then:** I return with a session and enter the app
- **Data:** GitHub enabled, grant completed

AS-007: A provider without ENV creds is not offered
- **Given:** the operator did not configure Google (no ENV creds)
- **When:** I open the sign-in / sign-up screen
- **Then:** no "Continue with Google" button is shown
- **Data:** Google not configured

AS-008: A denied or failed OAuth callback shows an error and creates no session
- **Given:** I start GitHub OAuth
- **When:** I deny the grant or the callback fails
- **Then:** I return to sign-in with an error message and no session is created
- **Data:** OAuth denied

### S-003: Accept an invite (P1)

**Description:** As an invited person, I accept a per-doc invite by opening its accept-link
(or by signing up with the invited email, which activates the role on verification).
**Source:** auth S-005 (AS-008 invited-email activates on verify, AS-009 wrong email, AS-011 acceptable via shareable link); sharing-permissions (per-doc invite).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`apps/web/` invite-accept landing)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Opening an accept-link grants the invited role
- **Given:** I hold a valid invite accept-link and am signed in with the matching email
- **When:** I open the accept-link landing and confirm
- **Then:** the invited role is granted on the doc and I'm taken to it
- **Data:** valid accept-link, matching signed-in email

AS-010: An accept-link used by the wrong account is refused
- **Given:** an invite was issued to `bob@acme.com`
- **When:** I am signed in as `eve@acme.com` and open Bob's accept-link
- **Then:** the role is not granted and I see a "this invite isn't for you" message
- **Data:** mismatched email

## Constraints & Invariants

- C-001: An email+password account cannot sign in until its email is verified; the FE shows a
  distinct verify-first state, never a generic credential error. (AS-002)
- C-002: Only operator-enabled OAuth providers (ENV creds present) are offered; a denied/failed
  callback yields no session and a visible error. (AS-007, AS-008)
- C-003: Identity always comes from the server session/cookie; no auth token is stored
  client-side (web-core's contract, reaffirmed here for the sign-up path). (AS-001)

## Linked Fields

auth-ui is the **consumer**; the backend `auth` feature is the producer (now complete, commit 336078c).

- `session` — consumed on every screen (web-core pins this); produced by `auth` better-auth. ✔.
- sign-up / verify endpoints — consumed by S-001; produced by `auth` better-auth `/api/auth/*`
  (email-verify send + verify wired). ✔.
- OAuth start/callback + enabled-provider list — consumed by S-002; produced by `auth` better-auth
  (providers conditional on ENV creds). The FE needs to know WHICH providers are enabled to render
  buttons (AS-007) — see GAP-002. ✘ no enabled-provider read endpoint yet → GAP-002.
- invite accept — consumed by S-003; produced by `auth` `POST /api/invite/accept` + invite-on-verify
  (both wired). ✔.

## UI Notes

From docs/explore/auth.md §UI sketches + DESIGN.md §Auth. All `[N]`. Mounts in the web-core
`AppShell`, pre-session (outside the AuthGuard). Precedence: AS / Constraints > Tree.

- `SignUpScreen` `[N]`: email · password *(≥8)* · submit · *error (AS-005)* · `OAuthButtons` *(reused)*
- `VerifyEmailSent` `[N]` *(post-sign-up "check your inbox" + resend)*
- `VerifyEmailLanding` `[N]` *(consumes the verify link → success / expired-or-invalid + resend, AS-003/004)*
- `OAuthButtons` `[N]` → `OAuthButton` *(only enabled providers render — AS-007)* · `OAuthErrorBanner` *(denied/failed — AS-008)*
- `InviteAcceptLanding` `[N]` *(accept-link route → confirm → role granted / wrong-account refusal, AS-009/010)*
- *(web-core owns `SignInScreen`, `AuthGuard`, `UserMenu` sign-out — not rebuilt here; SignInScreen GAINS the verify-first state of AS-002 + the OAuthButtons.)*

## What Already Exists

### System Impact & Technical Risks

- `web-core` built the auth foundation (sign-in/out/guard, typed client, session). auth-ui adds
  the remaining pre-session screens; SignInScreen is EXTENDED (verify-first state + OAuth buttons), not rebuilt.
- Backend `auth` is complete for this slice (commit 336078c): email-verify send, invite-on-verify,
  accept-link route all wired — so S-001/S-003 have a real backend.
- Magic-link is NOT wired (deferred v0.5) → not in this FE slice.
- No first-run wizard: providers + branding are ENV; workspace creation is automatic — neither is an auth-ui screen.

## Not in Scope

- **First-run setup wizard** (workspace name / provider toggles / branding form) — REMOVED:
  providers and branding are ENV-only; workspace creation is automatic. (Workspace lifecycle is the
  workspace feature's concern; multi-workspace + its UI is v0.5.)
- Magic-link sign-in — deferred v0.5 (not wired in the backend).
- Account settings / profile / password change — later.
- Signup gating policy (open vs invite-only) — pending the workspace research; the sign-up flow here
  builds the happy path and surfaces the backend's outcome.

## Gaps

- GAP-001 (status: open): signup gating — is sign-up open to anyone, or gated (first-user/admin +
  pending-invite emails only)? Decided in the workspace research; affects whether S-001 sign-up
  succeeds for an uninvited email. Source: self-host privacy discussion.
- GAP-002 (status: open): the FE needs to know which OAuth providers are enabled (ENV creds present)
  to render only those buttons (AS-007), and the OAuth callback error contract (where better-auth
  redirects on denied/failed so the FE can render `OAuthErrorBanner`, AS-008). A small backend read
  (enabled providers) + a pinned error-redirect are needed. Source: research "no enabled-provider read; OAuth error contract unpinned".

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-09 | Initial creation (FE auth: first-run, sign-up+verify, OAuth, invite-accept) | -- |
| 2026-06-09 | Removed first-run setup wizard (providers/branding → ENV; workspace creation automatic). 4 stories → 3. | -- |
