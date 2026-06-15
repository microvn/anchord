// Annotation create + read (annotation-core S-001). Pure logic + an injectable
// AnnotationRepo port, mirroring publish/service.ts (DocRepo) and services/version.ts.
// The bridge/postMessage transport and the select→mark→margin UI are FRONTEND /
// integration [→MANUAL]; this module owns: the anchor model, the create-path SERVER
// re-authorization (C-009/AS-020), and the read authorization (C-010/AS-021).

import { can, type Role } from "../sharing/roles";
import { type Viewer } from "../sharing/access";
import { isLabelPreset } from "./label-presets";

/** Annotation type — text range for S-001; image-region (S-002) reuses the table. */
export type AnnotationType = "range" | "multi_range" | "block" | "doc";

/**
 * One segment of a (possibly multi-) range anchor. A single range has one segment;
 * multi_range carries several (S-005 detaches the whole annotation if any is lost).
 */
export interface AnchorSegment {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
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
}

/**
 * Persistence port — the real implementation is thin Drizzle glue
 * (integration-verified-later). Keeping it a port makes the authz logic unit-testable
 * without a DB, the project's established pattern.
 */
export interface AnnotationRepo {
  insertAnnotation(input: NewAnnotation): Promise<{ id: string }>;
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
  const { docId, anchor, sessionRole, type, label } = input;

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
  });
  return { created: true, id };
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
