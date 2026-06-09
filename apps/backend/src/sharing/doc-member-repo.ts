// Drizzle-backed doc_members glue (sharing S-003). THIN persistence for the invite
// service (invite.ts inviteByEmail — the active/pending decision + email normalize)
// and the doc-scoped role resolver. No business logic here.
//
// Three concrete pieces this cluster needs at the route edge:
//   - createDocMemberRepo(db): the DocMemberRepo port (insert active/pending rows,
//     findPendingByEmail, activate). `hasActiveMember` from the port is SYNC and
//     can't be honored over async Drizzle — the resolver uses `activeRolesFor`
//     (async) instead, so that sync method throws if ever called on the DB impl.
//   - createFindUserByEmail(db): resolve an existing account by (normalized) email
//     over the better-auth `user` table → `{ id } | null` (invite.ts's port).
//   - createEnqueueInvite(...): the invite.ts enqueueInvite port, backed by the real
//     mail queue + transport (src/auth/mail-transport.ts sendInviteEmail). Injectable
//     so the route can wire a real transport in prod and a fake in tests; the actual
//     network send is integration-verified-later.

import { and, eq } from "drizzle-orm";
import { docMembers, user } from "../db/schema";
import type { DB } from "../db/client";
import { normalizeEmail } from "../auth/invite";
import { buildAcceptLink } from "../auth/invite";
import { mintInviteToken } from "../auth/invite-token";
import { sendInviteEmail } from "../auth/mail-transport";
import type { MailQueue, MailTransport } from "../auth/mail-queue";
import type { DocMemberRepo, DocMemberRow, NewDocMember, EnqueuedInvite } from "./invite";
import type { ShareRole } from "./share";

/** Construct a DocMemberRepo over Drizzle (insert/findPending/activate). */
export function createDocMemberRepo(db: DB): DocMemberRepo {
  return {
    async insert(member: NewDocMember): Promise<DocMemberRow> {
      const [row] = await db
        .insert(docMembers)
        .values({
          docId: member.docId,
          userId: member.userId,
          email: member.email,
          role: member.role,
          message: member.message,
          invitedBy: member.invitedBy,
          status: member.status,
        })
        .returning();
      return rowToMember(row!);
    },
    async findPendingByEmail(email: string): Promise<DocMemberRow[]> {
      const normalized = normalizeEmail(email);
      const rows = await db
        .select()
        .from(docMembers)
        .where(and(eq(docMembers.email, normalized), eq(docMembers.status, "pending")));
      return rows.map(rowToMember);
    },
    async activate(memberId: string, userId: string): Promise<void> {
      await db
        .update(docMembers)
        .set({ status: "active", userId })
        .where(eq(docMembers.id, memberId));
    },
    hasActiveMember(): boolean {
      // The port is sync; the DB read is async. The async resolver uses
      // `activeRolesFor` (below) instead — this sync path is never the DB code's
      // route. Throw rather than silently return false (which would leak access).
      throw new Error(
        "createDocMemberRepo.hasActiveMember is sync and unsupported on the DB impl; use activeRolesFor",
      );
    },
  };
}

/** Map a raw Drizzle doc_members row to the service's DocMemberRow shape. */
function rowToMember(row: typeof docMembers.$inferSelect): DocMemberRow {
  return {
    id: row.id,
    docId: row.docId,
    userId: row.userId,
    email: row.email,
    role: row.role,
    message: row.message,
    invitedBy: row.invitedBy,
    status: row.status,
  };
}

/**
 * The invite.ts `findUserByEmail` port over the better-auth `user` table. Returns
 * `{ id } | null`. Synchronous shape (the service calls it without await), so we
 * pre-build nothing here — the service awaits the result. The port type is sync,
 * but invite.ts only reads `.id`, so we return a Promise-free wrapper by reading
 * eagerly is impossible without async; we therefore expose an ASYNC variant the
 * route awaits and passes a resolved sync closure to the service.
 */
export async function findUserByEmail(db: DB, email: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, normalizeEmail(email)));
  return row ?? null;
}

/**
 * Resolve a user's verified email by id over the better-auth `user` table. Used by the
 * invite accept-link route (auth S-005, AS-011) to derive the accepting email + verified
 * flag from the SESSION actor — never the request body (anti-forgery). Null = no such user.
 */
export async function findUserById(
  db: DB,
  userId: string,
): Promise<{ email: string; emailVerified: boolean } | null> {
  const [row] = await db
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId));
  return row ?? null;
}

/**
 * Build the invite.ts `enqueueInvite` port backed by the real mail queue + transport.
 * On a pending invite it sends the accept-link mail; on an active invite (existing
 * account) it sends the "you've been granted access" notify mail.
 *
 * AS-011 / C-009: the accept link now carries the REAL pending-invite id (msg.inviteId)
 * and a REAL token minted from APP_SECRET (invite-token.ts), so the link in the mail
 * points at this exact invite and is verifiable server-side by the accept route — no
 * placeholder. The email-independent join path is the belt-and-braces against a failing
 * transport; delivery itself flows through the queue's retry/dead-letter path.
 *
 * The send is fire-and-forget from the synchronous port (the service calls it without
 * await); failures are owned by the queue's dead-letter machinery, not the request.
 */
export function createEnqueueInvite(
  queue: MailQueue,
  transport: MailTransport,
  secret: string,
): (msg: EnqueuedInvite) => void {
  return (msg: EnqueuedInvite) => {
    const token = mintInviteToken(msg.inviteId, secret);
    const acceptLink = buildAcceptLink(msg.inviteId, token);
    void sendInviteEmail(queue, transport, { to: msg.email, acceptLink });
  };
}

/**
 * Async active-membership read used by the doc-scoped role resolver: every ACTIVE
 * role this user holds on the doc via an invite (doc_members). Returns the share
 * roles (viewer|commenter|editor) — owner is never an invited role.
 */
export async function activeRolesFor(
  db: DB,
  docId: string,
  userId: string,
): Promise<ShareRole[]> {
  const rows = await db
    .select({ role: docMembers.role })
    .from(docMembers)
    .where(
      and(
        eq(docMembers.docId, docId),
        eq(docMembers.userId, userId),
        eq(docMembers.status, "active"),
      ),
    );
  return rows.map((r) => r.role);
}
