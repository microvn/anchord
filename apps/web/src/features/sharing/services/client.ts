import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";
import type { EffectiveRole } from "@/features/viewer/services/client";

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

// These thunks return the RAW Eden `{ data, error }` (the body is the api-core envelope
// `{ success, data: <payload>, … }`). Call sites unwrap with `unwrapEnvelope<T>(await thunk())` —
// the same convention features/docs uses for its direct calls (reads that go through useApiQuery are
// peeled there). Reading `res.data` WITHOUT unwrapping reads the envelope, not the payload (the bug
// peelEnvelope exists to prevent) — so every sharing call site unwraps.

/** The general-access level a doc is shared at (mirrors `docs.general_access`). */
export type GeneralAccessLevel = "restricted" | "anyone_in_workspace" | "anyone_with_link";

/** The role attached to general access / an invite — never `owner` (C-004). */
export type ShareRole = "viewer" | "commenter" | "editor";

/** A person row in the share state — active member or pending invite. */
export interface SharePerson {
  /** the doc_members row id — REQUIRED to target the PATCH/DELETE member routes (S-006). The
   *  share-state read must populate this; see Spec signal S1 (the backend read does not yet carry
   *  it). Optional on the type so a read without it still compiles; the row controls only persist
   *  when it is present. */
  id?: string;
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
  /** owner-only editable; drives the EDITOR manage-eligibility (C-002 / S-001 AS-004). */
  editorsCanShare: boolean;
  people: SharePerson[];
  link: ShareLink;
  /** the CALLER's own role on this doc — the dialog gates editors_can_share (owner-only, C-003)
   *  off this so it works from the docs-list entry too (which preloads no `effectiveRole`).
   *  Optional for back-compat with older reads / test fixtures. */
  viewerRole?: ShareRole | "owner";
  /** the EXTERNAL capability link (`/s/<token>`) — the unguessable, title-free address an anonymous
   *  visitor opens (capability-share-link S-005, backend AS-012). Present only when the doc is
   *  anyone_with_link; null/absent for restricted / anyone_in_workspace (AS-013). Distinct from
   *  `link.url`, the in-app readable `/d/<slug>` address. Optional for back-compat with older reads. */
  capabilityUrl?: string | null;
}

/** GET /api/w/:workspaceId/docs/:slug/share — the dialog-open prefill read (S-001 AS-018). */
export function getShareState(
  workspaceId: string,
  slug: string,
): Promise<EdenResult<ShareState>> {
  return treaty.api.w({ workspaceId }).docs({ slug }).share.get() as Promise<EdenResult<ShareState>>;
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

/** The general-access write payload (S-002). `level` + `role` are always sent; `editorsCanShare`
 *  (owner-only, C-003) is optional — only included when that control is the one being changed.
 *  (No guest-commenting field — a commenter+ link role IS the grant for guests, reversal
 *  2026-06-20.) */
export interface SetAccessInput {
  level: GeneralAccessLevel;
  role: ShareRole;
  editorsCanShare?: boolean;
}

/** What the backend echoes back from a successful access write (mirrors the request). */
export interface AccessResult {
  level: GeneralAccessLevel;
  role: ShareRole;
  editorsCanShare: boolean;
}

/** PUT /api/w/:workspaceId/docs/:slug/access — set general access + role + editors
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
  /** the new doc_members row id — lets the people list target PATCH/DELETE on the just-invited
   *  row without re-reading the share state (AS-022). */
  id: string;
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

/** What the backend echoes from a successful member role change (S-007). */
export interface ChangeMemberRoleResult {
  role: ShareRole;
}

/** PATCH /api/w/:workspaceId/docs/:slug/members/:memberId — change an existing member's role
 *  (sharing-permissions-ui S-006; backend sharing-permissions:S-007). On success the people-list
 *  row reflects the new role; a refused write rolls back the row (C-005). The owner row never
 *  reaches this (C-004 / backend C-017). */
export function changeMemberRole(
  workspaceId: string,
  slug: string,
  memberId: string,
  role: ShareRole,
): Promise<EdenResult<ChangeMemberRoleResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .members({ memberId })
    .patch({ role }) as Promise<EdenResult<ChangeMemberRoleResult>>;
}

/** What the backend echoes from a successful member removal (S-007). */
export interface RemoveMemberResult {
  removed: boolean;
}

/** DELETE /api/w/:workspaceId/docs/:slug/members/:memberId — remove an active member OR revoke a
 *  pending invite (the same row delete; backend sharing-permissions:S-007). On success the row
 *  disappears; a refused write restores it (C-005). The owner row never reaches this (C-004). */
export function removeMember(
  workspaceId: string,
  slug: string,
  memberId: string,
): Promise<EdenResult<RemoveMemberResult>> {
  return treaty.api
    .w({ workspaceId })
    .docs({ slug })
    .members({ memberId })
    .delete() as Promise<EdenResult<RemoveMemberResult>>;
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
