# Spec: auth

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

Multi-method sign up / sign in (email+password, GitHub, Google), DB-backed sessions,
operator toggles providers via config. Auth = *how* you sign in, separate from roles/share
(*what* you're allowed to do). Uses the better-auth library (it manages the auth schema itself).

## Data Model

- **Managed by better-auth:** `user`, `session`, `account`, `verification`.
- App tables (`workspaces`, `docs`, `annotations`, `comments`, `doc_members`,
  `api_tokens`…) reference `user.id`.
- Pending invite (`doc_members` in `sharing-permissions`) is picked up by email
  at sign up.
- **Email provider config (boot-mandatory, C-008):** either `SMTP_HOST`/`SMTP_PORT`/
  `SMTP_USER`/`SMTP_PASS` **or** `RESEND_API_KEY` (Resend HTTP API). At least one must be
  present at boot; both present → Resend API wins. `self-host` mirrors this env set.

## Stories

### S-001: Sign up / sign in with email + password (P0)

**Description:** As a user, I sign up and sign in with email + password; I get a
revocable session.
**Source:** docs/explore/auth.md#decisions (item 2 method set), #business-rules.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (expected: better-auth config + `src/auth/*`)
- `autonomous:` true
- `verify:` sign up email+pw → sign in → session exists; logout → session gone.

**Acceptance Scenarios:**

AS-001: Sign up then sign in with email+password
- **Given:** the email+password provider is enabled, SMTP is configured
- **When:** signing up with email+password, verifying the email, then signing in
- **Then:** account is active; a session exists (cookie); logout deletes the session
- **Data:** new email + password ≥ 8 characters

AS-002: Wrong password is rejected + rate-limited
- **Given:** an email+password account exists
- **When:** signing in with the wrong password several times in a row
- **Then:** rejected; past the failure threshold → retries are temporarily limited
- **Data:** repeated wrong password

### S-002: Sign in with OAuth (GitHub / Google) (P0)

**Description:** As a user, I sign in via GitHub or Google and get a session.
**Source:** docs/explore/auth.md#decisions (item 2), #happy-path.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (better-auth OAuth provider config)
- `autonomous:` checkpoint
- `verify:` "Continue with GitHub" → return with a session; provider disabled → button hidden.

**Acceptance Scenarios:**

AS-003: GitHub sign-in creates a session
- **Given:** the GitHub provider is enabled
- **When:** the user clicks "Continue with GitHub" and completes OAuth
- **Then:** an account is created (or matched), email treated as verified; a session exists
- **Data:** a valid GitHub account

AS-004: Failed/denied OAuth callback creates no session
- **Given:** the user starts OAuth but denies the grant / the callback fails
- **When:** returning to the app
- **Then:** no session is created; return to sign-in with an error message
- **Data:** OAuth cancelled

### S-003: Auto-link providers by verified email (P1)

**Description:** As a user who already has an account, when I sign in with a different
method using the same verified email, the system merges into the same account.
**Source:** docs/explore/auth.md#decisions (item 3 account linking).

**Execution:**
- `depends_on:` S-001, S-002
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` checkpoint
- `verify:` GitHub account (verified email) then Google sign-in with the same email → same account.

**Acceptance Scenarios:**

AS-005: Auto-link when email is verified
- **Given:** an account already exists with a verified email (e.g. via GitHub)
- **When:** the user signs in with Google using the same verified email
- **Then:** merge into the same account (no duplicate account created)
- **Data:** same email, both verified

AS-006: Do NOT auto-link when email is unverified
- **Given:** an account with an unverified email
- **When:** another method signs in with the same email (unverified)
- **Then:** do NOT auto-link (account-takeover protection); keep accounts separate until verified
- **Data:** unverified email

AS-010: OAuth returning email_verified=false does not auto-link [harden H3]
- **Given:** a verified account already exists for `victim@x.com`
- **When:** an OAuth sign-in returns `victim@x.com` but the provider does NOT assert
  `email_verified===true` (missing or false)
- **Then:** do NOT auto-link; route to a "link account" confirmation that requires proving
  ownership of the existing account
- **Data:** provider email_verified=false

### S-004: Operator toggles auth providers (P1)

**Description:** As a self-host operator, I enable/disable each provider via config; the UI only
shows enabled providers.
**Source:** docs/explore/auth.md#decisions (item 4 toggle).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (config/env)
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: A disabled provider is not shown and rejects callbacks
- **Given:** the operator disables Google in config
- **When:** the user opens the sign-in page
- **Then:** no Google button; if a Google callback is forced → rejected
- **Data:** Google off, GitHub on

### S-005: Activate pending invite on sign up (P0)

**Description:** As an invitee (sharing cluster) without an account, when I sign up
with exactly the invited email (verified), I receive the invited role.
**Source:** docs/explore/auth.md#cross-cluster (sharing pending invite).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (coordinated with sharing-permissions)
- `autonomous:` true
- `verify:` create a pending editor invite for email X → sign up X (verified) → has editor role.

**Acceptance Scenarios:**

AS-008: Signing up with the invited email activates the role
- **Given:** a pending invite exists (email `bob@x.com`, editor role) from the sharing cluster
- **When:** Bob signs up with `bob@x.com` and the email is verified
- **Then:** the invite activates; Bob has the editor role on the corresponding doc
- **Data:** email matches the pending invite

AS-009: A different email does not activate someone else's invite
- **Given:** a pending invite for `bob@x.com`
- **When:** someone else signs up with `eve@x.com`
- **Then:** they receive no role from the invite meant for `bob@x.com`
- **Data:** email does not match

AS-011: A runtime mail-send failure does not get stuck permanently [harden H6]
- **Given:** an email provider is configured OK at boot but the provider errors/rate-limits when sending
- **When:** a verify/invite is sent and the send fails
- **Then:** mail goes to a queue + retry; failures surface a status to the operator; the pending
  invite is still acceptable via an in-app/shareable link that does not depend on the email arriving
- **Data:** the provider returns a 5xx / rate-limit at runtime

AS-012: Mail is delivered via the configured email provider (Resend HTTP API)
- **Given:** `RESEND_API_KEY` is configured (Resend HTTP API is the active provider)
- **When:** a verification or invite email is enqueued for delivery
- **Then:** it is sent through the Resend transport via the shared mail-transport port + queue
  (the same port carries the SMTP transport when SMTP is the configured provider instead)
- **Data:** RESEND_API_KEY set, SMTP absent

## Constraints & Invariants

- C-001: DB-backed session (httpOnly cookie), revocable; logout deletes the session. (AS-001)
- C-002 [harden H3]: An email from OAuth is treated as verified ONLY when the provider explicitly
  asserts `email_verified === true`; missing/false → not treated as verified. email+password must
  be verified before auto-link. (AS-003, AS-006, AS-010)
- C-003: Auto-link only when the email is verified (account-takeover protection). (AS-005, AS-006)
- C-004: Providers are toggled via config; the UI only shows enabled providers; a disabled provider
  rejects callbacks. (AS-007)
- C-005: A pending invite activates when an account for that exact email exists + is verified. (AS-008, AS-009)
- C-006: Password minimum 8 characters (NIST-style, no rigid rules); hashed by
  better-auth. (AS-001)
- C-007: Sign-in is rate-limited against brute-force. (AS-002)
- C-008: An email provider is mandatory — the app does not start unless at least one is configured
  (SMTP **or** Resend HTTP API), like APP_SECRET; therefore email verify always works, no no-verify
  mode. Both configured → Resend API is used. (AS-001, AS-012)
- C-009 [harden H6]: A boot-mandatory email provider is DIFFERENT from being able to send at runtime —
  every outbound mail, via whichever transport (SMTP or Resend API), enqueues + retries + dead-letters
  + surfaces a "send failed" status to the operator; pending invites carry an accept link
  (in-app/shareable) that works regardless of whether the email arrives. (AS-011)
  _(Token hardening hashed/scope/revoke → `mcp-roundtrip` C-008.)_

## Linked Fields

- **pending invite (email→role)** — produced by `sharing-permissions:S-003` (AS-008).
  Consumed by auth:S-005 (AS-008) at sign up to assign the role. ✔ picked up by verified email.
- **`user.id`** — produced by auth (better-auth user). Consumed by every app table
  (workspace_members, docs.published_by, annotations, api_tokens…). ✔ the shared identity
  key across the whole system.

## UI Notes

From `docs/explore/auth.md` §UI sketches. Greenfield → `[N]`. Component names only.
Dark-operator (`DESIGN.md`). Precedence: AS > Tree.

- `SignInCard` `[N]`
  - `EmailField` · `PasswordField` · `SignInButton`
  - `OAuthButton` GitHub · `OAuthButton` Google *(only render providers the operator enabled — S-004)*
- `FirstRunSetup` `[N]` *(2-pane; **stacked** ≤760; runs first time only)*
  - `WorkspaceNameField` · `AdminEmailField`
  - `ProviderToggleList` → `ProviderToggle` *(email+pw / GitHub / Google)*
  - `SmtpStatus` *(mandatory — configured ✓ / blocks if missing, C-008)*
  - `CreateWorkspaceButton`

## What Already Exists

### System Impact & Technical Risks

- Greenfield repo. better-auth manages the auth schema → the old sketched `users` table yields to it.
- Cross-spec: `sharing-permissions` creates the pending invite; `mcp-roundtrip` issues API
  tokens bound to a user; `workspace-project` first-run admin = the first user; `self-host`
  provides APP_SECRET (session) + provider env + SMTP.
- Risk (sensitive): OAuth (external identity) + auto-link (account-takeover surface)
  → marked `checkpoint`; a mistake here is a security/account-takeover risk.

## Not in Scope

- Magic link → v0.5.
- GitLab OAuth → v0.5.
- OIDC/SAML SSO (plug in your own IdP) → v0.5 (better-auth SSO plugin).
- 2FA / passkey → v2.
- OAuth 2.1 Provider for MCP agent → decided by `mcp-roundtrip` (v0 uses API tokens).
- First-run instance admin (creating the workspace) → `workspace-project`.

## Gaps

- GAP-001 (status: resolved → C-008): an **email provider is mandatory** — the app does not
  start unless SMTP **or** Resend HTTP API is configured. So email verify always sends; no
  degrade mode. (Decided 2026-06-07; reverses explore's "SMTP optional" — `self-host` must
  update: an email provider is mandatory boot config like APP_SECRET. Generalized 2026-06-07
  from SMTP-only to SMTP-or-Resend.)
- GAP-002 (status: deferred): sign-in rate-limit threshold (number of attempts / lockout window)
  — decided at build time. Source: "Sign-in rate-limit enabled (threshold decided at build)".

## Clarifications — 2026-06-07

- **better-auth instead of rolling our own:** hand-writing the email+pw/OAuth/(SSO later) combo is
  easy to get wrong security-wise; better-auth is the 2026 choice for TS, fits Bun/Elysia/Drizzle, DB session.
- **DB session instead of JWT:** need revoke/logout/session ban for self-host.
- **v0 methods = email+pw + GitHub + Google;** magic link & GitLab move to v0.5; Google
  pulled up to v0.
- **Auto-link only when verified:** balances seamlessness vs account-takeover protection.
- **SMTP mandatory (reverses explore):** the app does not start without SMTP → email
  verify/invite/notify always works, drop all degrade logic. Affects `self-host`:
  SMTP_* becomes mandatory boot config.
- **Email provider generalized to SMTP or Resend HTTP API (2026-06-07):** the boot-mandatory
  requirement is an *email provider*, not SMTP specifically. Resend HTTP API (`RESEND_API_KEY`)
  is a first-class provider — better deliverability/observability than raw SMTP, and it slots
  into the existing `MailTransport` port + mail queue. SMTP stays valid (incl. Resend-over-SMTP).
  Both configured → Resend API wins. `self-host` env list mirrors `RESEND_API_KEY`.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/auth.md) | -- |
| 2026-06-07 | GAP-001 resolved → C-008 (SMTP mandatory, no degrade) | -- |
| 2026-06-07 | /mf-challenge harden: C-002 (auto-link requires email_verified) + AS-010; C-009 + AS-011 (SMTP runtime retry/dead-letter, invite accept-link) | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
| 2026-06-07 | Major: C-008/C-009 generalized SMTP→email-provider (SMTP or Resend HTTP API); +AS-012 (mail via configured provider); +RESEND_API_KEY config; self-host mirrors env | snapshot 2026-06-07.md |
