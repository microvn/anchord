## Explore: auth

_2026-06-07_

**Feature:** Multi-method sign up / sign in, operator toggles providers via
config. Auth = *how* you sign in (separate from roles/share = *what* you're allowed to do afterward).

**Trigger:** A user signs up / signs in; or receives a pending-invite (sharing cluster)
then signs up with the invited email.

**UI expectation:** A sign-in/sign-up page with an email+pw button + GitHub + Google buttons;
only show providers the operator enabled. Everything is **[N] NEW**.

---

### Decisions

**1. Library = better-auth.**
- Official Elysia + Bun + Drizzle adapter integration (hits the whole stack).
- DB session (httpOnly cookie), revocable — fits self-host (logout/session ban).
- Email+pw + OAuth built-in + SSO plugin (OIDC/SAML) for v0.5; operator toggles
  providers via config.
- Lucia is in maintenance mode (excluded); Auth.js leans Next (excluded).
- Bonus: better-auth v1.5 has an OAuth 2.1 Provider plugin supporting the **MCP agent** → used
  for the auth agent in the mcp-roundtrip cluster.

**2. v0 method set = email+password, GitHub OAuth, Google OAuth.**
- **Magic link MOVED down to v0.5** (the design doc placed it in v0, trimmed).
- Google PULLED UP to v0 (the design doc placed it in v0.5).
- v0.5+: magic link, GitLab, OIDC/SAML SSO (via the SSO plugin).

**3. Account linking = auto-link if the email is verified.**
- Providers with the same *verified* email → merge into 1 account (seamless). ONLY link when
  the email is verified (better-auth has a setting) — avoids the account-takeover hole via an
  unverified email.

**4. Operator toggles providers via config.**
- Enable/disable each provider (email/GitHub/Google) via env/config; the UI only shows enabled
  providers.

---

### Happy path

1. User opens /sign-in, clicks "Continue with GitHub" → OAuth → returns, better-auth creates
   user + session cookie → enters the app.
2. Another user signs up email+pw → receives a verify email → clicks the link → account active.
3. A user with a pending-invite (email `bob@x.com`, editor role) signs up with exactly that
   email → invite activates, Bob enters the doc with the editor role (sharing cluster).
4. A user who previously used GitHub now signs in with Google using the same verified email → auto
   link into the same account.

### Unhappy paths

- **Unverified email tries to link another provider:** no auto-link (account-takeover
  protection); forces verification or keeps accounts separate.
- **Provider disabled by the operator:** button hidden; if a callback is forced → rejected.
- **Failed/denied OAuth callback:** return to sign-in with an error message, no session
  created.
- **Wrong password several times:** rate-limit (better-auth supports it) → retries temporarily
  locked (threshold is an assumption).

### Business rules

- DB-backed session, httpOnly cookie; logout deletes the session.
- An email from an OAuth provider is treated as verified (the provider already verified it); email+pw must
  be verified before auto-link.
- A pending-invite matches by email when an account for that email becomes existing + verified.

### Input validation

- Email in valid format, unique per account.
- Password: min length + policy (assumption: min 8, no rigid special-character requirement
  — per NIST). Hashed by better-auth (scrypt/argon2 default).

### Permissions

- Auth has no "role" — it only authenticates identity. Authorization is the sharing cluster +
  workspace (workspace admin/member; doc roles).
- **First-run / instance admin** (self-host): the first user becomes workspace admin
  → belongs to the **workspace-project** cluster, note the coupling.

### Data impact

- **better-auth manages the auth schema:** `user`, `session`, `account`,
  `verification`. → The `users` table I originally sketched YIELDS to better-auth.
- App tables (`workspaces`, `workspace_members`, `docs`, `annotations`, `comments`)
  reference better-auth's `user.id`.
- The pending-invite (the `doc_members`/`doc_shares` table in the sharing cluster) must be
  picked up by auth at sign up.

### Out of scope (v0 — defer)

- Magic link → v0.5.
- GitLab OAuth → v0.5.
- OIDC/SAML SSO (plug in your own IdP) → v0.5, via the better-auth SSO plugin (a core
  self-host advantage but not v0).
- 2FA/passkey → v2 (better-auth has a plugin ready when needed).
- OAuth 2.1 Provider for MCP agent → the mcp-roundtrip cluster decides whether to use it.

### Decision rationale

- better-auth instead of rolling our own: hand-writing the email+pw/OAuth/(SSO later) combo is
  easy to get wrong security-wise; better-auth is the 2026 choice for TS, fits Bun/Elysia/Drizzle, DB session.
- DB session instead of JWT: need revoke/logout/session ban for self-host; JWT is hard to
  revoke.
- Auto-link only when verified: balances seamlessness vs account-takeover protection.
- Trim magic link from v0: reduces surface + early SMTP dependency; email+pw + 2 OAuth is
  enough to get in the door.

### Assumptions (need confirmation)

- Require email verification for email+pw sign-up; OAuth email treated as verified.
- Password min 8 characters (NIST-style, no rigid rules).
- Sign-in rate-limit enabled (threshold decided at build).

### Open questions

- **SMTP/email sending:** verify email + invite email + notify reply all need to send
  mail. How does the self-host operator configure SMTP, what's the default provider (or can it be
  disabled)? → couples **self-host** + **workspace-project (notify)**. Magic link is
  trimmed so email pressure drops, but verify + invite are still needed.
- If the operator disables all OAuth and hasn't configured SMTP → email verify can't send;
  do we need a "no verification needed" mode for internal instances?
- First-run admin: does the first user auto-become the instance admin? → workspace cluster.

### Complexity signal: **low-medium**

better-auth carries the heavy part. The remaining complexity: provider-toggle config, reconciling
the better-auth schema with the app tables, and picking up the pending-invite. SMTP is the unknown depending
on self-host.

### Cross-cluster dependencies

- **sharing-permissions:** pending-invite activates at sign up; password hashing
  (link password) can reuse better-auth utilities.
- **workspace-project:** first-run instance admin; user → workspace member.
- **mcp-roundtrip:** OAuth 2.1 Provider / token for the agent publish-pull.
- **self-host:** SMTP config + provider env; APP_SECRET secret for the session.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW.

**Sign in + First-run setup** `[N]` ← S-001 (email+pw) /S-002 (GitHub/Google)
/S-004 (provider toggle) · workspace-project S-001 (first-run admin) · self-host
(SMTP mandatory C-008)
```
┌─────────────────────────────┬─────────────────────────────┐
│ Sign in                     │ First-run setup             │
│ anchord · self-hosted       │ First user = instance admin  │
│ Email   [ you@team.com    ] │ Workspace [ microvn       ]  │
│ Password[ ········        ] │ Admin email[ hoang@…      ]  │
│        [    Sign in    ]    │ Email+password      ●──○ on  │
│ ─────── or ─────────        │ GitHub OAuth        ●──○ on  │ ←S-004
│ [ Continue with GitHub  ]   │ Google OAuth        ●──○ on  │
│ [ Continue with Google  ]   │ SMTP (required)  configured✓ │ ←self-host
│                             │     [ Create workspace ]     │
└─────────────────────────────┴─────────────────────────────┘ (≤760: stacked)
```
