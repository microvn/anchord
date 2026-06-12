import { api } from "../../lib/api";
import type { EdenResult } from "../../lib/use-api-query";
import type { EffectiveRole } from "../viewer/client";

// Typed request thunks for the sharing-permissions backend (the producer is already built). This
// story (S-001) adds only the PREFILL READ — `getShareState` → GET /api/w/:ws/docs/:slug/share
// (backend sharing-permissions:S-006). The three management WRITES (`PUT /access`, `POST /invites`,
// `PUT /link`) land in later stories (S-002..S-005) on this same module.
//
// Same rationale as features/viewer/client.ts + features/workspaces/client.ts: the backend mounts
// these routes CONDITIONALLY, so the exported `App` treaty type can't statically widen to include
// them. We reach them via the SAME runtime treaty client (`treaty as any`) and annotate the return
// ourselves. Component tests MOCK this module, so the cast is never exercised under test.
//
// Eden runtime path convention: static segments are property access, a `:param` segment is a
// function call carrying that param, and the verb (get/post/put) is the leaf call.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

/** The general-access level a doc is shared at (mirrors `docs.general_access`). */
export type GeneralAccessLevel = "restricted" | "anyone_in_workspace" | "anyone_with_link";

/** The role attached to general access / an invite — never `owner` (C-004). */
export type ShareRole = "viewer" | "commenter" | "editor";

/** A person row in the share state — active member or pending invite. */
export interface SharePerson {
  userId?: string;
  email: string;
  name?: string;
  /** the owner row carries `owner`; everyone else is a reassignable role. */
  role: ShareRole | "owner";
  status: "active" | "pending";
}

/** Link controls returned by the prefill read. `hasPassword` is a boolean ONLY — the password
 *  itself is never sent back (backend C-016). */
export interface ShareLink {
  hasPassword: boolean;
  expiresAt?: string | null;
  viewLimit?: number | null;
  viewCount?: number | null;
  url: string;
}

/** The full prefill state the dialog reads on OPEN (backend S-006, AS-018). */
export interface ShareState {
  level: GeneralAccessLevel;
  role: ShareRole;
  guestCommenting: boolean;
  /** owner-only editable; drives the EDITOR manage-eligibility (C-002 / S-001 AS-004). */
  editorsCanShare: boolean;
  people: SharePerson[];
  link: ShareLink;
}

/** GET /api/w/:workspaceId/docs/:slug/share — the dialog-open prefill read (S-001 AS-018). */
export function getShareState(
  workspaceId: string,
  slug: string,
): Promise<EdenResult<ShareState>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .share.get() as Promise<EdenResult<ShareState>>;
}

/** Does an Eden error represent a FORBIDDEN (403) response? The lazy manage-gate (C-002, reworked
 *  2026-06-13) distinguishes a refused gated read (→ read-only "can't manage" surface) from any
 *  other failure (network/500 → generic retryable error). Eden surfaces the HTTP status on the
 *  error object (`error.status`); we read it defensively since the runtime shape is `any`. */
export function isForbidden(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 403
  );
}

/** The general-access write payload (S-002). `level` + `role` are always sent; `guestCommenting`
 *  (only meaningful for anyone-with-link, C-001) and `editorsCanShare` (owner-only, C-003) are
 *  optional — only included when the corresponding control is the one being changed. */
export interface SetAccessInput {
  level: GeneralAccessLevel;
  role: ShareRole;
  guestCommenting?: boolean;
  editorsCanShare?: boolean;
}

/** What the backend echoes back from a successful access write (mirrors the request). */
export interface AccessResult {
  level: GeneralAccessLevel;
  role: ShareRole;
  guestCommenting: boolean;
  editorsCanShare: boolean;
}

/** PUT /api/w/:workspaceId/docs/:slug/access — set general access + role + guest + editors
 *  (sharing-permissions-ui S-002; backend sharing-permissions:S-001). The backend re-authorizes
 *  and 403s a refused write; the caller rolls back optimistically on `error` (C-005). */
export function setAccess(
  workspaceId: string,
  slug: string,
  input: SetAccessInput,
): Promise<EdenResult<AccessResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .access.put(input) as Promise<EdenResult<AccessResult>>;
}

/** The invite write payload (S-003). `message` is optional. `role` is never `owner` (C-004). */
export interface InvitePersonInput {
  email: string;
  role: ShareRole;
  message?: string;
}

/** What the backend returns from a successful invite (201). `status` says whether the invitee
 *  already has an account (`active`) or is a no-account pending invite (`pending`, AS-011). */
export interface InviteResult {
  status: "active" | "pending";
}

/** POST /api/w/:workspaceId/docs/:slug/invites — invite a person by email + role + optional
 *  message (sharing-permissions-ui S-003; backend sharing-permissions:S-003). On 201 the row is
 *  added active or pending; a refused write (403/400/network) rolls back the optimistic row (C-005).
 *  A malformed email is rejected inline BEFORE this is ever called (C-006). */
export function invitePerson(
  workspaceId: string,
  slug: string,
  input: InvitePersonInput,
): Promise<EdenResult<InviteResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .invites.post(input) as Promise<EdenResult<InviteResult>>;
}

/** The link-controls write payload (S-005). Each control is optional + independent (C-001 backend):
 *  only the control being changed is sent. `password: null` / `expiresAt: null` / `viewLimit: null`
 *  clears that control; a value sets it. */
export interface SetLinkInput {
  password?: string | null;
  expiresAt?: string | null;
  viewLimit?: number | null;
}

/** The link controls echoed back from a successful write (the prefill `ShareLink` shape). */
export type LinkResult = ShareLink;

/** PUT /api/w/:workspaceId/docs/:slug/link — set the optional link controls (password / expiry /
 *  view-limit) on an anyone-with-link doc (sharing-permissions-ui S-005; backend S-004). Each
 *  control is independent (C-001); a refused write rolls back the chip (C-005). */
export function setLinkControls(
  workspaceId: string,
  slug: string,
  input: SetLinkInput,
): Promise<EdenResult<LinkResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .link.put(input) as Promise<EdenResult<LinkResult>>;
}

// --- manage-eligibility gate (C-002) -------------------------------------------------------
// Mirror of backend C-007: the editable ShareDialog is shown only when the session CAN manage
// sharing — owner always; editor only when `editorsCanShare` is on (from the prefill read);
// viewer/commenter never. An ABSENT `effectiveRole` ⇒ NOT able to manage (conservative — a missing
// role must not expose the editable dialog; the server 403s the write regardless). This is a UI
// hint, never the security boundary.
export function canManageShare(
  effectiveRole: EffectiveRole | undefined,
  editorsCanShare: boolean | undefined,
): boolean {
  if (effectiveRole === "owner") return true;
  if (effectiveRole === "editor") return editorsCanShare === true;
  return false;
}
