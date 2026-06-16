// Suggestion annotation (annotation-core S-006, C-003 + C-011 [harden H5]). A reviewer
// creates a suggestion (replace/delete) on a range; it is a suggestion-TYPE annotation
// that NEVER edits the doc content itself (C-003). Accept/reject only flips the
// suggestion's status — applying the change into content is the MCP round-trip
// (mcp-roundtrip cluster), after which the author republishes.
//
// The immutability spine (C-003): the SuggestionRepo port deliberately exposes NO
// method that writes doc/version content. There is therefore NO code path in this
// module that can mutate content — not by policy, but structurally. createSuggestion
// only inserts a suggestion record; decideSuggestion only sets the suggestion's status.
//
// Stale check (C-011 / AS-022): a suggestion pins `againstVersion` + the exact `from`
// span. At accept time (and equally when an agent applies it via MCP) we verify the
// `from` span still matches AT THE ANCHOR in the CURRENT version's content — reusing the
// re-anchor matcher (injectBlockIds + extractBlockText). If it no longer matches, the
// suggestion is marked `stale` (a status distinct from pending so the UI can show it
// differently — that surface is [→MANUAL]); we do NOT mark it accepted and do NOT
// auto-apply.
//
// Pure authz + status logic + an injectable repo port, mirroring resolve.ts
// (ResolutionRepo) and annotation.ts (AnnotationRepo). The select->"suggest replace"
// ->margin UI and the "display stale differently" surface are FRONTEND [→MANUAL].

import { can, type Role } from "../sharing/roles";
import type { Anchor } from "./annotation";
import { injectBlockIds } from "./block-id";
import { extractBlockText } from "./reanchor";

/**
 * A suggestion's lifecycle status — distinct from the annotation `status`
 * (unresolved|resolved) so the two never collide. `stale` is a first-class status (not
 * an error) so a suggestion whose `from` drifted is visibly different from `pending`.
 */
export type SuggestionStatus = "pending" | "accepted" | "rejected" | "stale";

/**
 * The suggestion payload, kept in its own field on the record (not folded into the
 * annotation `status`). `kind:"replace"` carries from->to; `kind:"delete"` carries only
 * the `from` span to remove. `againstVersion` pins which version the `from` span was
 * captured against (C-011).
 */
export type SuggestionPayload =
  | { kind: "replace"; from: string; to: string; againstVersion: number }
  | { kind: "delete"; from: string; againstVersion: number };

/** A persisted suggestion-type annotation as the repo returns it. */
export interface SuggestionRow {
  id: string;
  docId: string;
  /** Always "suggestion" — this is a suggestion-type annotation. */
  type: "suggestion";
  anchor: Anchor;
  suggestion: SuggestionPayload;
  status: SuggestionStatus;
  /**
   * annotation-actions S-001 / C-005: the durable creator identity (the session actor's
   * account id, or null for a guest), persisted at create on the suggestion-type annotation.
   * Optional on the row shape so existing reads that don't select it stay valid.
   */
  authorId?: string | null;
}

/**
 * Persistence port. NOTE (C-003): there is intentionally NO setDocContent /
 * setVersionContent method here. A suggestion can only ever insert itself or change its
 * own status; it can never reach doc content. The real implementation is thin Drizzle
 * glue (integration-verified-later) — keeping it a port makes the logic unit-testable
 * without a DB, the project's established pattern.
 */
export interface SuggestionRepo {
  insertSuggestion(row: SuggestionRow): Promise<{ id: string }>;
  getSuggestion(id: string): Promise<SuggestionRow | null>;
  setSuggestionStatus(id: string, status: SuggestionStatus): Promise<void>;
}

export interface CreateSuggestionInput {
  docId: string;
  anchor: Anchor;
  /** The exact span the suggestion targets (pinned for the C-011 stale check). */
  from: string;
  /** The replacement content (replace only); omit for a delete suggestion. */
  to?: string;
  /** The version the `from` span was captured against (C-011). */
  againstVersion: number;
  /**
   * The role resolved SERVER-side from the session (mirrors S-001 create). This — and
   * ONLY this — authorizes the write; never a client/iframe-supplied claim.
   */
  sessionRole: Role;
  /**
   * annotation-actions S-001 / C-005 (AS-001/AS-002): the acting user's account id, resolved
   * SERVER-side — null for a guest. Persisted as the suggestion's durable creator (`author_id`);
   * never a client-supplied claim, mirroring `sessionRole`.
   */
  authorId?: string | null;
  /** Optional explicit id (the real repo generates one); tests pass a fixed id. */
  id?: string;
}

export type CreateSuggestionResult =
  | { created: true; id: string }
  | { created: false; reason: "forbidden" };

let counter = 0;

/**
 * Create a suggestion-type annotation (AS-014 / C-003).
 *
 * Authz: gated SOLELY by `can(sessionRole, "comment")` — a suggestion is a kind of
 * comment, so commenter/editor/owner may create one; a viewer cannot.
 *
 * The status starts `pending`. The doc content is NEVER written — this function only
 * inserts a suggestion record. (The repo has no content-write method to call.)
 */
export async function createSuggestion(
  input: CreateSuggestionInput,
  repo: SuggestionRepo,
): Promise<CreateSuggestionResult> {
  const { docId, anchor, from, to, againstVersion, sessionRole, authorId, id } = input;

  // C-003 authz path: a suggestion is a comment-class action; viewer is forbidden.
  if (!can(sessionRole, "comment")) {
    return { created: false, reason: "forbidden" };
  }

  const payload: SuggestionPayload =
    to === undefined
      ? { kind: "delete", from, againstVersion }
      : { kind: "replace", from, to, againstVersion };

  const row: SuggestionRow = {
    id: id ?? `sug-${++counter}`,
    docId,
    type: "suggestion",
    anchor,
    suggestion: payload,
    status: "pending", // default status (AS-014)
    // S-001 / C-005 (AS-001/AS-002): the durable creator — the session actor, or null for a guest.
    authorId: authorId ?? null,
  };

  const { id: newId } = await repo.insertSuggestion(row);
  return { created: true, id: newId };
}

export interface DecideSuggestionInput {
  suggestionId: string;
  decision: "accept" | "reject";
  /**
   * The CURRENT version's rendered content HTML — used only on accept to verify the
   * `from` span still matches at the anchor (C-011). Not consulted on reject.
   */
  currentVersionContentHtml: string;
}

export type DecideSuggestionResult =
  | { ok: true; status: SuggestionStatus }
  | { ok: false; reason: "not_found" };

/**
 * Whether the suggestion's `from` span still matches AT THE ANCHOR in the given content
 * (C-011 / AS-022). Reuses the re-anchor matcher: inject block ids, pull the anchored
 * block's text, and check the exact `from` span is present in it. A `from` that drifted
 * (block deleted, or span rewritten away) returns false → the suggestion is stale.
 */
function fromStillMatches(row: SuggestionRow, currentContentHtml: string): boolean {
  const injected = injectBlockIds(currentContentHtml);
  const blockText = extractBlockText(injected, row.anchor.blockId);
  if (blockText === null) return false; // block deleted → no match
  return blockText.includes(row.suggestion.from);
}

/**
 * Accept or reject a suggestion (AS-015 / AS-022 / C-003 / C-011).
 *
 * reject → status `rejected`, content untouched.
 * accept → FIRST verify the `from` span still matches at the anchor in the current
 *   version content. Matches → status `accepted` (content STILL not edited here —
 *   applying is the MCP round-trip). Does NOT match → status `stale`, NOT accepted, NOT
 *   auto-applied (C-011 / AS-022).
 *
 * In every branch the doc content is untouched: the repo has no content-write method, so
 * the only write this function can make is the suggestion's own status.
 */
export async function decideSuggestion(
  input: DecideSuggestionInput,
  repo: SuggestionRepo,
): Promise<DecideSuggestionResult> {
  const { suggestionId, decision, currentVersionContentHtml } = input;

  const row = await repo.getSuggestion(suggestionId);
  if (row === null) return { ok: false, reason: "not_found" };

  if (decision === "reject") {
    // AS-015: reject only flips status; content never touched, no match check needed.
    await repo.setSuggestionStatus(suggestionId, "rejected");
    return { ok: true, status: "rejected" };
  }

  // accept: C-011 / AS-022 — verify the `from` span still matches at the anchor.
  const target: SuggestionStatus = fromStillMatches(row, currentVersionContentHtml)
    ? "accepted" // AS-015: status only; content applied later via MCP.
    : "stale"; // AS-022: drifted → stale, do NOT accept, do NOT auto-apply.

  await repo.setSuggestionStatus(suggestionId, target);
  return { ok: true, status: target };
}
