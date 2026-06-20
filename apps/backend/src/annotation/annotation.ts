// Annotation create + read (annotation-core S-001). Pure logic + an injectable
// AnnotationRepo port, mirroring publish/service.ts (DocRepo) and services/version.ts.
// The bridge/postMessage transport and the select→mark→margin UI are FRONTEND /
// integration [→MANUAL]; this module owns: the anchor model, the create-path SERVER
// re-authorization (C-009/AS-020), and the read authorization (C-010/AS-021).

import { can, type Role } from "../sharing/roles";
import { type Viewer } from "../sharing/access";
import { isLabelPreset } from "./label-presets";
import { sanitizeInert, cleanGuestName } from "./guest";
import type { SuggestionPayload, SuggestionStatus } from "./suggestion";

/**
 * Annotation type — text range for S-001; image-region (S-002) reuses the table;
 * `suggestion` is a suggestion-type annotation (S-006) riding the same table, surfaced
 * here so the list read (AS-030) can carry its kind back to the viewer.
 */
export type AnnotationType = "range" | "multi_range" | "block" | "doc" | "suggestion";

/**
 * One segment of a (possibly multi-) range anchor. A single range has one segment;
 * multi_range carries several (S-005 detaches the whole annotation if any is lost).
 */
export interface AnchorSegment {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  /**
   * annotation-reanchor:C-004 — W3C TextQuoteSelector context: ≤32 chars of block text
   * immediately before (`prefix`) / after (`suffix`) the selection, captured at create.
   * Used by the whole-doc re-anchor fallback to reject a coincidental same-text mention
   * in different context (AS-003). Optional — an old anchor lacking them degrades to
   * text_snippet+offset matching.
   */
  prefix?: string;
  suffix?: string;
}

/**
 * Anchor descriptor stored as the annotation's jsonb. block_id is a positional hint
 * (C-001); text_snippet need only be unique WITHIN its block, disambiguated by block_id
 * — which is how a duplicate quote in two blocks anchors to the chosen one (AS-003).
 */
export interface Anchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  /**
   * annotation-reanchor:C-004 — W3C TextQuoteSelector context for the PRIMARY segment (≤32 chars
   * each). Optional; absent on an old anchor (degrades to text_snippet+offset matching).
   */
  prefix?: string;
  suffix?: string;
  /** Present only for multi_range; a single range omits it. */
  segments?: AnchorSegment[];
  /**
   * Present only for an image-region anchor (S-002): a point/box in normalized 0..1
   * coordinates relative to the ORIGINAL image. A text anchor omits it. Kept as a plain
   * tagged record so the jsonb stays portable. Defined in image-region.ts.
   */
  region?: { kind: "point"; x: number; y: number } | { kind: "box"; x: number; y: number; w: number; h: number };
}

export interface BuildAnchorInput {
  blockId: string;
  text: string;
  offset: number;
  length: number;
  segments?: AnchorSegment[];
}

/**
 * Build an anchor descriptor from a selection. Empty/whitespace-only text is NOT a
 * real selection (AS-004): return null so the caller creates no annotation and shows
 * no comment box. The raw selected text is trimmed into text_snippet but offset/length
 * describe the ORIGINAL selection in the block (the UI maps back to it).
 */
export function buildAnchor(input: BuildAnchorInput): Anchor | null {
  const { blockId, text, offset, length, segments } = input;

  // AS-004: a 0-character or whitespace-only selection is ignored.
  if (text == null || text.trim().length === 0) return null;

  return {
    blockId,
    textSnippet: text,
    offset,
    length,
    ...(segments && segments.length > 0 ? { segments } : {}),
  };
}

/** A persisted annotation as the repo returns it. */
export interface AnnotationRow {
  id: string;
  docId: string;
  type: AnnotationType;
  anchor: Anchor;
  isOrphaned: boolean;
  status: "unresolved" | "resolved";
  /**
   * S-009 / C-015: a label-preset id (a member of DEFAULT_LABEL_PRESETS) on a signal
   * annotation, or null/absent on an ordinary one. Served on read (AS-027) — consumed by
   * the FE rail label line.
   */
  label?: string | null;
  /**
   * S-006 / AS-030: the suggestion payload + its lifecycle status, present ONLY on a
   * suggestion-type annotation (null/absent otherwise). Served on the list read so the
   * viewer renders the redline/suggestion kind + lifecycle (pending/accepted/rejected/stale)
   * from the read alone — mirrors `label` (AS-027).
   */
  suggestion?: SuggestionPayload | null;
  suggestionStatus?: SuggestionStatus | null;
  /**
   * annotation-actions S-001 / C-005 (AS-001/AS-002): the durable creator identity,
   * written AT CREATE from the session actor — the account user-id, or null for a guest.
   * This is the SINGLE authoritative creator fact every own-vs-others gate keys on
   * (delete-own, owner-no-self-approve); it is NOT derived from the root comment. Served
   * on the read as `authorId`. Null/absent ⇒ a guest with no durable identity to own-gate.
   */
  authorId?: string | null;
}

/**
 * One comment in an annotation's thread, shaped for the viewer read (S-003): the
 * annotation-core-ui list contract is `{ id, parentId, authorName|guestName, body, createdAt }`
 * (annotation-core-ui.md §Read). A session comment carries `authorName` (resolved from the user),
 * a guest comment carries `guestName`; exactly one is present.
 */
export interface ViewerComment {
  id: string;
  parentId: string | null;
  authorName?: string;
  guestName?: string;
  body: string;
  createdAt: string;
}

/** An annotation plus its flat comment thread — what the viewer read (S-003) returns. */
export interface AnnotationWithComments extends AnnotationRow {
  comments: ViewerComment[];
}

/** What createAnnotation hands the repo to persist. */
export interface NewAnnotation {
  docId: string;
  type: AnnotationType;
  anchor: Anchor;
  /** S-009 / C-015: the validated label-preset id, or null for an ordinary annotation. */
  label?: string | null;
  /**
   * annotation-actions S-001 / C-005: the creator's account user-id at create, or null
   * for a guest. Persisted to annotations.author_id — the durable creator identity.
   */
  authorId?: string | null;
  /**
   * C-018 / S-006: a suggestion payload + its initial lifecycle status, present ONLY when the
   * create carries a suggestion (a redline / replace). Persisted onto the SAME annotations row
   * (`suggestion` jsonb + `suggestion_status`) — the suggestion-create is now subsumed into the
   * unified create. Null/absent for an ordinary annotation.
   */
  suggestion?: SuggestionPayload | null;
  suggestionStatus?: SuggestionStatus | null;
}

/**
 * C-018: the already-sanitized first comment to persist ATOMICALLY with the annotation in ONE
 * transaction. `body` is the inert plaintext (sanitized at the service boundary, C-008); a guest
 * carries a cleaned `guestName` (no email — AS-017) and a null `authorId`; a member carries
 * `authorId` and no guest fields. A commentless create (future pure highlight) omits this entirely.
 */
export interface NewFirstComment {
  body: string;
  authorId: string | null;
  guestName: string | null;
}

/**
 * Persistence port — the real implementation is thin Drizzle glue
 * (integration-verified-later). Keeping it a port makes the authz logic unit-testable
 * without a DB, the project's established pattern.
 */
export interface AnnotationRepo {
  insertAnnotation(input: NewAnnotation): Promise<{ id: string }>;
  /**
   * C-018: persist an annotation AND its first comment in ONE atomic transaction (and bump the
   * annotation's updated_at). A failure of EITHER insert rolls the whole transaction back — no
   * orphan annotation with no comment is ever left behind (the bug this fixes). When `comment` is
   * omitted, this creates the annotation alone (a commentless highlight), returning no commentId.
   */
  insertAnnotationWithComment(
    annotation: NewAnnotation,
    comment?: NewFirstComment,
  ): Promise<{ id: string; commentId?: string }>;
  listByDoc(docId: string): Promise<AnnotationRow[]>;
  /**
   * Every comment on the doc's annotations (S-003 read), each tagged with its `annotationId`
   * so the domain can group threads. One query for the whole doc — no per-annotation N+1.
   */
  listCommentsByDoc(docId: string): Promise<(ViewerComment & { annotationId: string })[]>;
}

export interface CreateAnnotationInput {
  docId: string;
  anchor: Anchor;
  /** Who is acting (for audit/authoring); the WRITE gate is sessionRole, not this. */
  viewer: Viewer;
  /**
   * The role resolved SERVER-side from the session (C-009). This — and ONLY this —
   * authorizes the write. Never a client/iframe-supplied claim.
   */
  sessionRole: Role;
  type?: AnnotationType;
  /**
   * S-009 / C-015: an optional label-preset id for a signal annotation (Like = `looks-good`,
   * or a chosen label). Validated SERVER-side against DEFAULT_LABEL_PRESETS at this boundary —
   * an unknown / forged id is refused (AS-028). Mutually exclusive with a suggestion payload
   * (AS-029) — structurally enforced by the separate suggestion-create endpoint.
   */
  label?: string | null;
  /**
   * annotation-actions S-001 / C-005 (AS-001/AS-002): the acting user's account id, resolved
   * SERVER-side from the session — null for a guest (no account). Persisted verbatim as the
   * annotation's durable creator (`author_id`). Like `sessionRole`, this comes from the actor,
   * never a client/iframe-supplied claim; a null here is exactly the guest case (AS-002).
   */
  authorId?: string | null;
}

export type CreateAnnotationResult =
  | { created: true; id: string }
  | { created: false; reason: "forbidden" }
  // S-009 / AS-028: the submitted label is not a member of the known preset set.
  | { created: false; reason: "invalid_label" };

/**
 * Create a text annotation, re-authorizing the write SERVER-side (C-009/AS-020).
 *
 * The bridge treats every message from the sandboxed iframe as an untrusted HINT: a
 * forged `parent.postMessage({...annotation..., role:"owner", authorized:true})` from
 * the doc body carries no authority. The write is gated SOLELY by `sessionRole`
 * (resolved from the session), checked with `can(sessionRole, "comment")` — the shared
 * capability contract. A spoofed authority field on the payload is structurally absent
 * here: this function takes no such field, so it cannot be honored.
 *
 * AS-003: the anchor is persisted with the EXACT block_id the user selected, so a
 * duplicate snippet living in another block never mis-anchors.
 */
export async function createAnnotation(
  input: CreateAnnotationInput,
  repo: AnnotationRepo,
): Promise<CreateAnnotationResult> {
  const { docId, anchor, sessionRole, type, label, authorId } = input;

  // C-009/AS-020: server re-authorization. Only the session-resolved role gates the
  // write — a viewer/none session cannot create an annotation no matter what the
  // (untrusted) iframe message claimed.
  if (!can(sessionRole, "comment")) {
    return { created: false, reason: "forbidden" };
  }

  // S-009 / C-015 (AS-028): a label, when present, MUST be a known preset id. A foreign /
  // forged / markup-bearing id is refused here — it never reaches the repo. (The label ↔
  // suggestion mutual exclusion, AS-029, is enforced by the separate create endpoints.)
  if (label != null && !isLabelPreset(label)) {
    return { created: false, reason: "invalid_label" };
  }

  const { id } = await repo.insertAnnotation({
    docId,
    type: type ?? "range",
    anchor, // AS-003: the chosen block_id is stored verbatim.
    label: label ?? null, // AS-027: persisted; null for an ordinary annotation.
    // S-001 / C-005 (AS-001/AS-002): the durable creator — the session actor, or null for a guest.
    authorId: authorId ?? null,
  });
  return { created: true, id };
}

/** The first comment the unified create may carry (C-018). A member supplies only `body`; a guest
 *  supplies `body` + `guestName` (no email — AS-017). Identity (authorId/null) is decided by
 *  the service from the session, never the body. Omit `comment` for a commentless highlight. */
export interface FirstCommentInput {
  body: string;
  /** S-007 (AS-017): a guest's self-entered name (name only, no email). Absent for a member. */
  guestName?: string;
}

/** S-006 (AS-014): the suggestion payload the unified create may carry, subsuming the standalone
 *  suggestion-create (C-018). `from` is the pinned span; omit `to` for a delete-kind redline. */
export interface CreateSuggestionPayloadInput {
  from: string;
  to?: string;
  againstVersion: number;
}

export interface CreateAnnotationWithCommentInput extends CreateAnnotationInput {
  /**
   * C-018: the optional initial comment, persisted ATOMICALLY with the annotation. The body is
   * sanitized to inert plaintext here (C-008) and a guest name is cleaned/length-capped before the
   * single transaction. Omit for a commentless highlight (creates the annotation alone).
   */
  comment?: FirstCommentInput;
  /**
   * S-006 (AS-014) / C-018: the optional suggestion payload — when present the created annotation is
   * a suggestion-type one (the standalone suggestion-create is subsumed). Mutually exclusive with a
   * label (AS-029, refused). A creator who can EDIT the doc has their own proposal born `accepted`
   * (mirrors createSuggestion's auto-accept); a commenter's stays `pending`.
   */
  suggestion?: CreateSuggestionPayloadInput;
}

export type CreateAnnotationWithCommentResult =
  | { created: true; id: string; commentId?: string }
  | { created: false; reason: "forbidden" }
  | { created: false; reason: "invalid_label" }
  // AS-029: a label and a suggestion are mutually exclusive.
  | { created: false; reason: "label_and_suggestion" }
  // A commented create with an empty/whitespace-only body is refused (mirrors addComment).
  | { created: false; reason: "empty_body" }
  // A guest comment requires a non-empty name (S-007 / C-007).
  | { created: false; reason: "empty_name" };

/**
 * C-018: create an annotation AND its first comment (and/or a suggestion payload) in ONE atomic
 * write. The annotation row + the comment are inserted in a SINGLE transaction (in the repo); a
 * failure of either persists NEITHER — no orphan annotation with no comment is ever left behind
 * (the bug this fixes). The create re-authorizes server-side (C-009), validates the label
 * (AS-028) and the label↔suggestion exclusion (AS-029), sanitizes the comment body + guest name
 * (C-008, reusing the guest sanitize logic), and — when a suggestion is present — applies the
 * same born-accepted-for-editors rule createSuggestion uses.
 *
 * A commentless create (future pure highlight) omits `comment` and creates the annotation alone.
 */
export async function createAnnotationWithComment(
  input: CreateAnnotationWithCommentInput,
  repo: AnnotationRepo,
): Promise<CreateAnnotationWithCommentResult> {
  const { docId, anchor, sessionRole, type, label, authorId, comment, suggestion } = input;

  // C-009/AS-020: server re-authorization — only a session role that may comment can create.
  if (!can(sessionRole, "comment")) {
    return { created: false, reason: "forbidden" };
  }

  // AS-029: a label annotation and a suggestion are mutually exclusive.
  if (label != null && suggestion != null) {
    return { created: false, reason: "label_and_suggestion" };
  }

  // AS-028: a label, when present, MUST be a known preset id — a forged id never reaches the repo.
  if (label != null && !isLabelPreset(label)) {
    return { created: false, reason: "invalid_label" };
  }

  // Build the (already-sanitized) first comment, if any. A guest (no authorId) must supply a name;
  // a member posts body-only. The body is sanitized to inert plaintext at this boundary (C-008).
  let newComment: NewFirstComment | undefined;
  if (comment != null) {
    if (comment.body == null || comment.body.trim().length === 0) {
      return { created: false, reason: "empty_body" };
    }
    const isGuest = authorId == null;
    let guestName: string | null = null;
    if (isGuest) {
      // S-007 / C-008: a guest comment requires a non-empty name; clean it first so an HTML-only
      // name (which sanitizes to empty) is correctly rejected, not stored blank.
      const cleaned = cleanGuestName(comment.guestName ?? "");
      if (cleaned.length === 0) {
        return { created: false, reason: "empty_name" };
      }
      guestName = cleaned;
    }
    newComment = {
      body: sanitizeInert(comment.body), // C-008/AS-019: stored inert.
      authorId: authorId ?? null,
      guestName,
    };
  }

  // S-006 (AS-014): a suggestion payload makes this a suggestion-type annotation. The born status
  // mirrors createSuggestion — an editor's own proposal is born accepted (it matches by
  // construction at create), a commenter's stays pending awaiting an owner decision.
  let suggestionPayload: SuggestionPayload | null = null;
  let suggestionStatus: SuggestionStatus | null = null;
  let annotationType: AnnotationType = type ?? "range";
  if (suggestion != null) {
    annotationType = "suggestion";
    suggestionPayload =
      suggestion.to === undefined
        ? { kind: "delete", from: suggestion.from, againstVersion: suggestion.againstVersion }
        : { kind: "replace", from: suggestion.from, to: suggestion.to, againstVersion: suggestion.againstVersion };
    suggestionStatus = can(sessionRole, "edit") ? "accepted" : "pending";
  }

  const { id, commentId } = await repo.insertAnnotationWithComment(
    {
      docId,
      type: annotationType,
      anchor, // AS-003: the chosen block_id is stored verbatim.
      label: label ?? null,
      authorId: authorId ?? null,
      suggestion: suggestionPayload,
      suggestionStatus,
    },
    newComment,
  );
  return { created: true, id, ...(commentId != null ? { commentId } : {}) };
}

export interface ListAnnotationsInput {
  docId: string;
  /**
   * doc-access-routing S-001 / AS-007: the reader's PRE-RESOLVED view access, decided by
   * the route's single `resolveAccess` gate. The service no longer re-runs `canViewDoc`
   * with permissive stub deps (the bug that let any logged-in user read a restricted
   * doc's threads) — the route is the authoritative wall and passes its decision in.
   */
  canView: boolean;
}

export type ListAnnotationsResult =
  | { allowed: true; annotations: AnnotationWithComments[] }
  | { allowed: false; annotations: [] };

/**
 * List a doc's annotations, authorized by the reader's effective access to the PARENT
 * doc (C-010/AS-021/AS-007). The view decision is made by the route's single
 * `resolveAccess` gate and handed in as `canView`. A reader without permission gets a
 * clean deny with NO content: the repo is never even queried, so no thread text leaks.
 */
export async function listAnnotations(
  input: ListAnnotationsInput,
  repo: AnnotationRepo,
): Promise<ListAnnotationsResult> {
  const { docId, canView } = input;

  if (!canView) {
    // AS-021/AS-007: denied → no content. Do not touch the repo.
    return { allowed: false, annotations: [] };
  }

  const [rows, allComments] = await Promise.all([
    repo.listByDoc(docId),
    repo.listCommentsByDoc(docId),
  ]);

  // Group comments by annotation (creation order is preserved by the repo's ORDER BY), stripping
  // the grouping key so each thread matches the viewer contract `{ id, parentId, …, createdAt }`.
  const threads = new Map<string, ViewerComment[]>();
  for (const { annotationId, ...comment } of allComments) {
    const thread = threads.get(annotationId);
    if (thread) thread.push(comment);
    else threads.set(annotationId, [comment]);
  }

  const annotations = rows.map((row) => ({ ...row, comments: threads.get(row.id) ?? [] }));
  return { allowed: true, annotations };
}
