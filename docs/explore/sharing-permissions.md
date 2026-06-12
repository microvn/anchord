## Explore: sharing-permissions

_2026-06-07_

**Feature:** Google-Docs-style sharing model for a doc: 4 roles, 3 general-access levels,
guest commenting, invite by email, and link controls (password/expiry/view-limit).
Decides "who can open the link, who can do what".

**Trigger:** Owner/editor opens the "Share" box on a doc → set general-access + role, invite
emails, toggle guest commenting on/off, set password/expiry/limit.

**UI expectation:** Google-Docs-style Share box: people + role list, general-access
dropdown, invite field for email + role + message, link area (copy, password,
expiry, view-limit). Entirely **[N] NEW**.

---

### Decisions

**1. Share model = 1 general-access + link controls (Google Docs).**
Each doc has a single general-access setting, NOT multiple named links. Password/
expiry/view-limit attach to the doc's link.

**2. Three general-access levels (with a role for the link):**
- `restricted` — only specifically invited people.
- `anyone_with_link` — anyone with the link gets access; pick a role for the link (viewer/
  commenter). + guest commenting sub-toggle.
- `anyone_in_workspace` — every workspace member; pick a role.

**3. Anonymous view + random name.**
- `anyone_with_link` allows **anonymous viewing, no account needed**.
- Anonymous people are assigned a **random name** (e.g. "Anonymous Dolphin"); if they choose to
  rename themselves it updates. They can comment when the doc has guest commenting on (enter name + optional
  email, still no account needed).

**4. Link controls — all 3, all optional.**
- Password (optional): correct entry required to get in.
- Expiry (optional): past the deadline → link stops working.
- View-limit (optional): total opens; exceeded → link stops working.
- Stopped working → "Link no longer available" page (+ request-access button if the owner enables it, v0.5).

**5. Invite by email = pending invite + email.**
- Invite email + role + message → send email; if no account → the invite is **pending**,
  keyed to the email; they sign up with that email → automatically get the role. Couples the **auth** cluster.

**6. 4 roles + capabilities (doc-level):**
| Role | View | Comment/reply/resolve | Create version / edit content | Share / delete / transfer |
|---|---|---|---|---|
| viewer | ✅ | ❌ | ❌ | ❌ |
| commenter | ✅ | ✅ | ❌ | ❌ |
| editor | ✅ | ✅ | ✅ | ❌ |
| owner | ✅ | ✅ | ✅ | ✅ |

**7. Precedence = highest role wins.**
If a person is both invited (editor) and falls under general-access (commenter) →
they get editor.

---

### Happy path

1. Owner opens Share on "Payment Spec", sets general-access = anyone_with_link, role
   = commenter, enables guest commenting, sets a 7-day expiry.
2. Copy the link and send it to an external reviewer (no account).
3. Reviewer opens the link → views it right away, the system assigns the name "Anonymous Cat"; selects
   text to comment → enters their real name "Lan" + email → comment saved with guestName "Lan".
4. Owner additionally invites `bob@x.com` with role editor + message "please review the refund part" →
   Bob has no account → receives the invite email; Bob signs up → enters the doc with the editor role.

### Unhappy paths

- **Expired:** after 7 days, opening the link → "Link no longer available". (No request
  access in v0.)
- **Wrong password:** wrong entry → error shown, content not leaked.
- **Restricted + stranger:** doc restricted, uninvited person opens the link → "You
  do not have access" (no request access in v0).
- **Viewer tries to comment:** UI shows no comment box; API denies if they try to call it.

### Business rules

- One general-access setting per doc; link controls optional and independent of each other.
- Highest role wins across multiple access sources.
- Guest commenting is only available when general-access = anyone_with_link.
- A pending invite is keyed by email, activates when an account for that email exists.

### Input validation

- Invite email: valid format; role ∈ {viewer, commenter, editor, owner}.
- Link password: min 4 characters (assumption).
- Expiry: a future date. View-limit: integer > 0.
- guestName: non-empty when a guest comments; email optional and valid format.

### Permissions (about sharing itself)

- **Change general-access / invite / set link controls / transfer:** owner. Can an editor
  invite at a level ≤ their own role? (assumption: only the owner manages sharing in v0).
- **See who currently has access:** owner/editor.

### Data impact

- `docs.general_access` (enum, already in the sketched schema).
- New tables: `doc_shares` / `doc_members` (userId|email pending, role, message,
  invitedBy) + `share_links` (docId, role, passwordHash?, expiresAt?, viewLimit?,
  viewCount).
- `comments.guestName` (already there); add a random-name mechanism for anon viewers (could
  be session-level only, no need to persist unless they comment).
- Pending invite needs to be picked up by auth at sign up (couples auth).

### Out of scope (v0 — defer)

- Request access + owner approval → v0.5.
- Transfer ownership → v0.5 (put it in the table but defer the UI).
- Multiple named share-links per doc → v0.5+.
- Project/workspace default share settings, project role override → the
  workspace-project cluster (v0.5).
- Block copy/download for viewers → v2.
- Editor inviting others → v0 is owner-only for sharing.

### Decision rationale

- Single general-access instead of multi-link: simpler, matches Google Docs; multi-link
  adds management/revoke overhead not needed in v0.
- Anon view + random name: matches the "send to someone without an account" wedge; a random
  name gives a seamless commenting experience before people name themselves.
- Pending invite: allows inviting new people (not just those with an existing account) — needed for
  real collaboration; accept the coupling with auth.
- All 3 link controls: §4.3 marks v0; all optional so they don't force complexity when unused.

### Assumptions (need confirmation)

- Only the owner manages sharing in v0 (editors don't invite people).
- The random anon name is session-level, only persisted when a guest comments.
- Link password min 4 characters; expiry measured in days.

### Open questions

- Does view-limit count total opens or unique viewers? (proposal: total opens, simpler).
- anyone_in_workspace in a v0 single-workspace is nearly = every member — is there any real
  difference from internal anyone_with_link? Confirm once the workspace cluster is clear.
- How long until a pending invite expires? Is it needed?
- Password stored as a hash (bcrypt/argon2) — decide alongside auth.

### Complexity signal: **medium**

The model is clear (Google Docs), but it has many facets: roles × access × link controls × guest
× pending invite, and coupling with auth (pending) + workspace (anyone_in_workspace).

### Cross-cluster dependencies

- **auth:** pending invite activates at sign up; shared password hashing.
- **annotation-core:** role decides who can comment/resolve/moderate; the guest toggle
  turns guest commenting on/off; guestName.
- **render-publish / versioning-diff:** general-access decides who opens `/d/:slug`;
  only editor+ can create a version.
- **workspace-project:** anyone_in_workspace; default share settings + project role
  override (v0.5); workspace member directory.
- **mcp-roundtrip:** agent publish/pull may need a corresponding token/role.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW. `⬤`=teal · `▢`=pending.

**Share dialog** `[N]` ← S-001 (3 tier) /S-003 (invite pending) /S-004 (link
password/expiry/view-limit) /S-005 (roles+precedence C-002) · C-003 (guest toggle)
```
┌──────────────────────────────────────────┐
│ ⚓ Share        annotation-core         ✕ │
│ GENERAL ACCESS                            │
│ [Restricted][anyone-in-workspace][⬤anyone-with-link] [Commenter▾]│
│ Guest commenting (name+email)       ●──○  │ ← C-003
│ LINK  [ …/d/annotation-core      ] [Copy] │
│ (🔒 password)(⏲ expiry 7d)(view-limit off)│ ← S-004
│ INVITE [ email… ][Editor▾] [Invite]       │ ← S-003 pending
│ PEOPLE  ⬤HG Hoang — owner                  │
│         ▢bob@x.com — editor · pending      │
│         ⬤Lan — commenter (highest role wins, C-002)│
└──────────────────────────────────────────┘   (mobile: full-screen sheet)
```
