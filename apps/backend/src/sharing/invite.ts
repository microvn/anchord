// Invite-by-email service (sharing S-003): an owner invites someone to a doc by
// email + role + message.
//
// AS-007: the email already has an account → grant the role immediately (an ACTIVE
//         doc_members row bound to that user) + notify them.
// AS-008: the email has NO account → a PENDING doc_members row (userId null, matched
//         on email); it activates when an account for that email is created + verified.
// C-006:  a pending invite is keyed by email and activates when an account for that
//         exact email exists + is verified — the verification gate lives in auth's
//         activatePendingInvites (src/auth/invite.ts); THIS file provides the concrete
//         PendingInviteRepo (over doc_members) that auth drives, plus the producer that
//         creates the pending rows.
//
// Pure logic + injectable ports (mirrors share.ts / access.ts). The real Drizzle glue
// over the doc_members table — and auth calling the concrete repo live at signup — is
// integration-verified-later; the LOGIC + the repo adapter are unit-tested against an
// in-memory member store.

import { normalizeEmail, type PendingInvite, type PendingInviteRepo } from "../auth/invite";
import type { ShareRole } from "./share";

/** One doc_members row, as the store/repo expose it (mirrors the Drizzle row shape). */
export interface DocMemberRow {
  id: string;
  docId: string;
  /** Bound user once an account exists; null while pending. */
  userId: string | null;
  /** Invited email, stored normalized (lowercase + trim) for exact pending-match. */
  email: string;
  role: ShareRole;
  message: string | null;
  invitedBy: string;
  status: "active" | "pending";
}

/** Args to create a doc_members row (id + createdAt are assigned by the store/DB). */
export interface NewDocMember {
  docId: string;
  userId: string | null;
  email: string;
  role: ShareRole;
  message: string | null;
  invitedBy: string;
  status: "active" | "pending";
}

/**
 * Persistence port over doc_members. The concrete impl is thin Drizzle glue
 * (integration-verified-later); unit tests use the in-memory fake below.
 */
export interface DocMemberRepo {
  /** Insert a doc_members row; returns the stored row (id assigned). */
  insert(member: NewDocMember): Promise<DocMemberRow>;
  /** All PENDING rows issued to this (already-normalized) email. */
  findPendingByEmail(email: string): Promise<DocMemberRow[]>;
  /** Flip a row to active + bind it to userId (idempotent on already-active rows). */
  activate(memberId: string, userId: string): Promise<void>;
  /** True if an ACTIVE row binds userId to docId (concrete isInvited backing). */
  hasActiveMember(docId: string, userId: string): boolean;
  /**
   * S-007 (AS-028): change a member's role. Scoped by docId so a member of another
   * doc can't be touched; returns the updated row, or null when no row matches
   * (wrong doc / not found — e.g. the owner, who has no doc_members row).
   */
  updateRole(memberId: string, docId: string, role: ShareRole): Promise<DocMemberRow | null>;
  /**
   * S-007 (AS-029/030): remove an active member or revoke a pending invite. Scoped by
   * docId; returns whether a row was deleted (false → not a member of this doc → 404).
   */
  remove(memberId: string, docId: string): Promise<boolean>;
}

export interface EnqueuedInvite {
  /** "active" → notify an existing member; "pending" → invite mail with accept path. */
  kind: "active" | "pending";
  email: string;
  /**
   * The doc_members row id of the invite just created. For a pending invite this is the
   * id the accept-link is minted against (auth AS-011 / C-009) — the email-independent
   * path needs a REAL id, not a placeholder, so a handed-out link points at this invite.
   */
  inviteId: string;
}

export interface InviteDeps {
  /** Resolve an existing account by email (normalized match). Null = no account. */
  findUserByEmail(email: string): { id: string } | null;
  members: DocMemberRepo;
  /** Enqueue the notify/invite mail (real transport injected at the edge; see mail-*). */
  enqueueInvite(msg: EnqueuedInvite): void;
}

export interface InviteInput {
  docId: string;
  email: string;
  role: ShareRole;
  message?: string;
  invitedBy: string;
}

export type InviteResult = { status: "active"; role: ShareRole } | { status: "pending" };

/**
 * Invite someone to a doc by email + role + message.
 *
 * - account EXISTS → insert an ACTIVE doc_members row (userId bound, role) → enqueue a
 *   notify mail → `{ status: "active", role }` (AS-007).
 * - NO account → insert a PENDING row (userId null, email, role) → enqueue an invite
 *   mail → `{ status: "pending" }` (AS-008). The row activates later via auth's
 *   activatePendingInvites driving the concrete repo (C-006).
 *
 * Email is normalized (lowercase + trim) for the account lookup AND stored normalized,
 * so the later pending-match + isInvited stay exact and consistent.
 */
export async function inviteByEmail(input: InviteInput, deps: InviteDeps): Promise<InviteResult> {
  const email = normalizeEmail(input.email);
  const message = input.message ?? null;

  const account = deps.findUserByEmail(email);

  if (account) {
    const activeRow = await deps.members.insert({
      docId: input.docId,
      userId: account.id,
      email,
      role: input.role,
      message,
      invitedBy: input.invitedBy,
      status: "active",
    });
    deps.enqueueInvite({ kind: "active", email, inviteId: activeRow.id });
    return { status: "active", role: input.role };
  }

  const pendingRow = await deps.members.insert({
    docId: input.docId,
    userId: null,
    email,
    role: input.role,
    message,
    invitedBy: input.invitedBy,
    status: "pending",
  });
  // AS-011: the enqueue carries the REAL pending-invite id so the invite mail's accept-link
  // points at this invite (no placeholder) — the email-independent join path (C-009).
  deps.enqueueInvite({ kind: "pending", email, inviteId: pendingRow.id });
  return { status: "pending" };
}

/**
 * Concrete `PendingInviteRepo` (the shape src/auth/invite.ts expects) backed by a
 * DocMemberRepo. auth's `activatePendingInvites` drives this at signup: it finds the
 * invitee's pending rows by email and flips each to active, binding the new userId —
 * yielding the invited role on the doc (C-006 / AS-008). Mapping a doc_members row to
 * the auth port's PendingInvite is the whole job; the verification gate lives in auth.
 */
export function createDocMembersPendingInviteRepo(repo: DocMemberRepo): PendingInviteRepo {
  return {
    async findPendingByEmail(email: string): Promise<PendingInvite[]> {
      const rows = await repo.findPendingByEmail(normalizeEmail(email));
      return rows.map((r) => ({
        id: r.id,
        docId: r.docId,
        email: r.email,
        role: r.role,
        status: r.status,
      }));
    },
    activate(inviteId: string, userId: string): Promise<void> {
      return repo.activate(inviteId, userId);
    },
  };
}

/**
 * Concrete `isInvited(docId, userId)` backing for S-002's access.ts port: true when an
 * ACTIVE doc_members row binds the user to the doc. Wiring this into access.ts is
 * integration; here it gives that port a real implementation over the same store.
 */
export function makeIsInvited(repo: DocMemberRepo): (docId: string, userId: string) => boolean {
  return (docId, userId) => repo.hasActiveMember(docId, userId);
}

// ---------------------------------------------------------------------------
// In-memory fake store implementing DocMemberRepo — for unit tests (mirrors the
// share.ts fakeRepo pattern). The real Drizzle-backed store is integration-only.
// ---------------------------------------------------------------------------

export interface FakeDocMemberStore extends DocMemberRepo {
  /** Snapshot of all rows (test inspection). */
  rows(): DocMemberRow[];
}

export function createFakeDocMemberStore(): FakeDocMemberStore {
  const items = new Map<string, DocMemberRow>();
  let seq = 0;

  return {
    async insert(member: NewDocMember): Promise<DocMemberRow> {
      const id = `dm_${++seq}`;
      const row: DocMemberRow = { id, ...member };
      items.set(id, row);
      return { ...row };
    },
    async findPendingByEmail(email: string): Promise<DocMemberRow[]> {
      const normalized = normalizeEmail(email);
      return [...items.values()]
        .filter((r) => r.status === "pending" && normalizeEmail(r.email) === normalized)
        .map((r) => ({ ...r }));
    },
    async activate(memberId: string, userId: string): Promise<void> {
      const row = items.get(memberId);
      if (!row) return;
      row.status = "active";
      row.userId = userId;
    },
    hasActiveMember(docId: string, userId: string): boolean {
      return [...items.values()].some(
        (r) => r.status === "active" && r.docId === docId && r.userId === userId,
      );
    },
    async updateRole(memberId: string, docId: string, role: ShareRole): Promise<DocMemberRow | null> {
      const row = items.get(memberId);
      if (!row || row.docId !== docId) return null;
      row.role = role;
      return { ...row };
    },
    async remove(memberId: string, docId: string): Promise<boolean> {
      const row = items.get(memberId);
      if (!row || row.docId !== docId) return false;
      items.delete(memberId);
      return true;
    },
    rows(): DocMemberRow[] {
      return [...items.values()].map((r) => ({ ...r }));
    },
  };
}
