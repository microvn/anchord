// Guest commenting (annotation-core S-007). Someone opens an anyone-with-link doc
// without an account: they view under a random anon name (AS-016), and when they
// comment they enter a name + optional email (AS-017). Guest-supplied content is
// UNTRUSTED — both body and guest_name are sanitized so any HTML/script renders
// inert at the app origin, and the name is length/charset-limited (C-008/AS-019).
//
// Pure logic + the injectable CommentRepo port from reply.ts — DB/HTTP glue and the
// composer / GuestNameField UI are FRONTEND/integration [→MANUAL].
//
// REUSE, do not reimplement:
//   - generateAnonName (src/sharing/anon-identity.ts) for the session anon name.
//   - DOMPurify (isomorphic-dompurify), the same sanitizer the markdown render path
//     uses, to neutralize HTML/script in guest content.

import DOMPurify from "isomorphic-dompurify";
import { generateAnonName, type AnimalPicker } from "../sharing/anon-identity";
import type { CommentRepo, NewComment } from "./reply";

/**
 * Max length for a guest_name (C-008). A display name is short by nature; capping it
 * stops an "unusually long" name from being stored/rendered and bloating the thread.
 */
export const MAX_GUEST_NAME_LENGTH = 80;

/**
 * Assign a random anon display name for a logged-out viewing session (AS-016).
 * Thin reuse of the sharing module's generator — annotation-core does NOT own the
 * animal list or the picker, it only borrows the name. The picker stays injectable
 * so callers/tests can be deterministic.
 */
export function assignAnonName(picker?: AnimalPicker): string {
  return generateAnonName(picker);
}

/**
 * Sanitize untrusted guest text to an INERT, plaintext form (C-008/AS-019). DOMPurify
 * with no allowed tags/attrs strips every element and event handler — `<script>` is
 * removed and `<img src=x onerror=...>` loses its `onerror` (the whole tag is dropped),
 * so nothing executable survives. We store this sanitized form (sanitize-on-store for
 * guest content), guaranteeing the thread renders inert no matter the render surface.
 */
function sanitizeInert(input: string): string {
  return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/**
 * Clean a guest_name (C-008): sanitize to inert plaintext, strip control characters
 * (charset limit), collapse surrounding whitespace, and truncate to the cap. The order
 * matters — sanitize first so an HTML name can't smuggle a tag past the length cut.
 */
function cleanGuestName(raw: string): string {
  const inert = sanitizeInert(raw);
  // Strip ASCII control chars (incl. newlines/tabs) — a display name is one line.
  // eslint-disable-next-line no-control-regex
  const noControl = inert.replace(/[\x00-\x1F\x7F]/g, "");
  const trimmed = noControl.trim();
  return trimmed.slice(0, MAX_GUEST_NAME_LENGTH);
}

export interface CreateGuestCommentInput {
  annotationId: string;
  /** The name the guest typed; REQUIRED and non-empty after cleaning (C-007). */
  guestName: string;
  /** Optional — stored verbatim-ish if supplied, never required (AS-017). */
  email?: string;
  body: string;
  /**
   * Whether the doc has guest commenting enabled. The toggle itself lives in
   * sharing-permissions — this only consumes the resolved boolean; if false the
   * comment is rejected (do not rebuild the toggle here).
   */
  guestCommentingEnabled: boolean;
}

export type CreateGuestCommentResult =
  | { created: true; id: string }
  | { created: false; reason: "guest_disabled" | "empty_name" | "empty_body" };

/**
 * Create a guest comment (S-007). Stored with `guest_name` set and `author_id` NULL
 * (AS-017); `email` is optional and stored on the row only when given.
 *
 * Guards:
 *  - guestCommentingEnabled false → rejected (C-007 — the doc must allow it).
 *  - empty/whitespace-only name (after sanitize) → rejected: guest comments REQUIRE a
 *    name (C-007).
 *  - empty/whitespace-only body → rejected (mirrors addReply — no empty content).
 *
 * Hardening (C-008/AS-019): body is sanitized to inert plaintext and guest_name is
 * sanitized + control-stripped + truncated to MAX_GUEST_NAME_LENGTH BEFORE persisting,
 * so the stored value carries no executable script/handler and no over-long name.
 */
export async function createGuestComment(
  input: CreateGuestCommentInput,
  repo: GuestCommentRepo,
): Promise<CreateGuestCommentResult> {
  const { annotationId, guestName, email, body, guestCommentingEnabled } = input;

  // C-007: the doc must have guest commenting turned on.
  if (!guestCommentingEnabled) {
    return { created: false, reason: "guest_disabled" };
  }

  // C-007: a guest comment REQUIRES a name. Clean first so an HTML-only / control-only
  // name (which sanitizes to empty) is correctly rejected, not stored as blank.
  const cleanName = cleanGuestName(guestName ?? "");
  if (cleanName.length === 0) {
    return { created: false, reason: "empty_name" };
  }

  // No empty body (same rule as addReply).
  if (body == null || body.trim().length === 0) {
    return { created: false, reason: "empty_body" };
  }

  // C-008/AS-019: store the sanitized, inert form of the body.
  const cleanBody = sanitizeInert(body);

  const { id } = await repo.insertComment({
    annotationId,
    parentId: null, // a guest comment is a top-level comment on the annotation.
    authorId: null, // AS-017: no account.
    guestName: cleanName, // AS-017: the entered name, cleaned (C-008).
    body: cleanBody,
    // email is optional — only attach the key when supplied (AS-017).
    ...(email != null && email.trim().length > 0 ? { guestEmail: email.trim() } : {}),
  });
  return { created: true, id };
}

/**
 * The CommentRepo (from reply.ts) extended with the optional guest email field. The
 * `comments` table carries a nullable guest_email alongside guest_name; addReply never
 * needed it, so it lives here as a widening of NewComment rather than changing reply.ts.
 */
export interface NewGuestComment extends NewComment {
  guestEmail?: string;
}

export interface GuestCommentRepo extends CommentRepo {
  insertComment(input: NewGuestComment): Promise<{ id: string }>;
}
