// Guest commenting (annotation-core S-007). Someone opens an anyone-with-link doc
// without an account: they view under a random anon name (AS-016), and when they
// comment they enter a name only — NO email is collected or stored (AS-017). Guest-supplied content is
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
export function sanitizeInert(input: string): string {
  return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
}

/**
 * Clean a guest_name (C-008): sanitize to inert plaintext, strip control characters
 * (charset limit), collapse surrounding whitespace, and truncate to the cap. The order
 * matters — sanitize first so an HTML name can't smuggle a tag past the length cut.
 */
export function cleanGuestName(raw: string): string {
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
  body: string;
}

export type CreateGuestCommentResult =
  | { created: true; id: string }
  | { created: false; reason: "empty_name" | "empty_body" };

/**
 * Create a guest comment (S-007). Stored with `guest_name` set and `author_id` NULL
 * (AS-017); NO email is collected or stored — guest identity is the name only.
 *
 * Authorization (Google-Docs model, sharing-permissions reversal 2026-06-20): there is
 * NO separate guest-commenting toggle — an anon caller is admitted to this path purely
 * by the doc's LINK ROLE (commenter+ on an anyone_with_link doc; the link role IS the
 * grant). The route gates that before calling here, so this service no longer takes or
 * checks a `guestCommentingEnabled` flag.
 *
 * Guards:
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
  const { annotationId, guestName, body } = input;

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
  });
  return { created: true, id };
}

/**
 * The CommentRepo (from reply.ts) port for guest comments. A guest comment carries
 * guest_name (+ a null author_id) — NO email field (AS-017, 2026-06-20). It is a
 * type alias of NewComment rather than a widening; addReply never needed any guest field.
 */
export type NewGuestComment = NewComment;

export interface GuestCommentRepo extends CommentRepo {
  insertComment(input: NewGuestComment): Promise<{ id: string }>;
}
