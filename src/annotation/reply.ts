// Reply in a thread (annotation-core S-003). A participant replies to a comment;
// the reply must show FLAT under the annotation — one level, never deeply nested
// (C-004). Pure logic + an injectable CommentRepo port, mirroring annotation.ts
// (AnnotationRepo) — DB/HTTP glue and the reply-box / ReplyList UI are
// FRONTEND/integration [→MANUAL]. This module owns: the create-reply SERVER
// re-authorization (reusing can(role,"comment"), like S-001 create) and the
// flatness invariant (a reply's parent is ALWAYS the thread's root comment).

import { can, type Role } from "../sharing/roles";

/**
 * A persisted comment row as the repo returns it. Mirrors the `comments` table
 * (annotation-core S-001 schema): a top comment has parentId === null; a reply
 * carries the root comment's id in parentId. Flatness (C-004) means parentId, when
 * set, ALWAYS points at a root comment — never at another reply.
 */
export interface CommentRow {
  id: string;
  annotationId: string;
  /** NULL = top/root comment; otherwise the ROOT comment's id (never a reply's). */
  parentId: string | null;
  /** Signed-in author; NULL for a guest comment (S-007), which carries guestName. */
  authorId: string | null;
  guestName: string | null;
  body: string;
}

/** What addReply hands the repo to persist. createdAt is the DB's to assign. */
export interface NewComment {
  annotationId: string;
  parentId: string | null;
  authorId: string | null;
  guestName: string | null;
  body: string;
}

/**
 * Persistence port for comments — the real implementation is thin Drizzle glue
 * (integration-verified-later). Keeping it a port makes the authz + flatness logic
 * unit-testable without a DB, the project's established pattern (AnnotationRepo).
 */
export interface CommentRepo {
  /** All comments on an annotation, in thread order (root(s) then replies). */
  listByAnnotation(annotationId: string): Promise<CommentRow[]>;
  insertComment(input: NewComment): Promise<{ id: string }>;
}

/** Who is replying — a signed-in author, or a guest carrying a display name (S-007). */
export type ReplyAuthor =
  | { kind: "user"; userId: string }
  | { kind: "guest"; guestName: string };

export interface AddReplyInput {
  annotationId: string;
  /** The comment the user clicked "Reply" on. May itself be a reply — we flatten. */
  parentCommentId: string;
  body: string;
  author: ReplyAuthor;
  /**
   * Role resolved SERVER-side from the session (like S-001 create). This — and ONLY
   * this — authorizes the write; never a client/iframe-supplied claim.
   */
  sessionRole: Role;
}

export type AddReplyResult =
  | { created: true; id: string; parentId: string }
  | { created: false; reason: "forbidden" | "empty_body" | "parent_not_found" };

/**
 * Resolve the FLAT parent for a reply (C-004). A thread is exactly one level:
 *   - target is a root comment (parentId === null) → parent stays the target.
 *   - target is itself a reply (parentId set)      → FLATTEN to target.parentId,
 *     i.e. the same root, so depth never exceeds 1.
 * Returns the root comment's id, or null if the target isn't in the thread.
 */
export function flattenedParentId(
  parentCommentId: string,
  thread: CommentRow[],
): string | null {
  const target = thread.find((c) => c.id === parentCommentId);
  if (!target) return null;
  // If the target is already a reply, its own parent is the root — reply to THAT,
  // never to the reply itself (would make depth 2). If it's a root, use it directly.
  return target.parentId ?? target.id;
}

/**
 * Compute the depth of every comment in a thread: a root is depth 0, a reply is 1.
 * The flatness invariant (C-004) is that NO comment ever exceeds depth 1 — a reply's
 * parent must be a root, so no parent is itself a reply. Used to assert flatness in
 * tests and as a structure helper the UI can lean on.
 */
export function threadDepth(thread: CommentRow[]): number {
  const byId = new Map(thread.map((c) => [c.id, c]));
  let max = 0;
  for (const c of thread) {
    let depth = 0;
    let cur: CommentRow | undefined = c;
    const seen = new Set<string>();
    while (cur && cur.parentId != null && !seen.has(cur.id)) {
      seen.add(cur.id);
      depth += 1;
      cur = byId.get(cur.parentId);
    }
    if (depth > max) max = depth;
  }
  return max;
}

/**
 * Add a reply to a comment under an annotation (S-003).
 *
 * Authz: gated SOLELY by `sessionRole` via `can(sessionRole, "comment")` — the same
 * shared capability contract S-001 create uses. A viewer/none session cannot reply.
 *
 * Flatness (C-004): the reply's stored parentId is the ROOT comment of the thread,
 * resolved by flattenedParentId — so replying to a reply collapses to one level and
 * thread depth never exceeds 1.
 *
 * Edge: an empty/whitespace-only body is rejected (no empty replies); a parent id
 * not in the thread is rejected (nothing to attach to).
 */
export async function addReply(
  input: AddReplyInput,
  repo: CommentRepo,
): Promise<AddReplyResult> {
  const { annotationId, parentCommentId, body, author, sessionRole } = input;

  // Server re-authorization (mirrors S-001 create): only a session role that can
  // comment may reply. An untrusted iframe claim carries no authority here.
  if (!can(sessionRole, "comment")) {
    return { created: false, reason: "forbidden" };
  }

  // No empty replies — a 0-char / whitespace-only body is not real content.
  if (body == null || body.trim().length === 0) {
    return { created: false, reason: "empty_body" };
  }

  const thread = await repo.listByAnnotation(annotationId);
  const parentId = flattenedParentId(parentCommentId, thread);
  if (parentId == null) {
    return { created: false, reason: "parent_not_found" };
  }

  const { id } = await repo.insertComment({
    annotationId,
    parentId, // C-004: always the root comment, never another reply.
    authorId: author.kind === "user" ? author.userId : null,
    guestName: author.kind === "guest" ? author.guestName : null,
    body,
  });
  return { created: true, id, parentId };
}
