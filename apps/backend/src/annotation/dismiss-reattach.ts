// Dismiss or re-attach a DETACHED (is_orphaned) annotation (annotation-core S-008, C-013).
//
// A detached annotation (re-anchor lost its block/snippet, S-005) accumulates in the
// "detached" list. S-008 lets someone with COMMENT permission or higher clear it up two ways:
//   - DISMISS  → soft: stamp `dismissed_at`. The annotation leaves the ACTIVE list (the list
//                read excludes a dismissed row, same as a soft-deleted one) but is NOT
//                hard-deleted — the row is kept (AS-023).
//   - RE-ATTACH → onto a range the caller selected in the CURRENT version: clear `is_orphaned`
//                and set a FRESH anchor, so it returns as an anchored annotation (AS-024). The
//                submitted anchor must actually PLACE against the current content — an anchor
//                that no block/snippet matches is refused (the route surfaces that as 400).
//
// Pure authz + injectable ports, mirroring delete.ts (deleteAnnotation/restoreAnnotation):
// the route owns session-required + existence-hiding 404 + parent-doc binding + resolving the
// caller's doc-scoped role; this module owns the COMMENT-permission gate (C-013) and the
// dismiss / re-attach writes. The anchor-placement validation is a pure check the route feeds
// the current version content into.
//
// C-013: both actions require comment permission or higher (commenter | editor | owner); a
//         viewer-only caller is refused and the annotation is unchanged (AS-025). The gate is
//         the SAME capability resolve/comment use — `can(role, "comment")` — not a contextual
//         own/owner check (unlike delete): dismissing/re-attaching is housekeeping any
//         commenter+ may do on the shared detached list, not an ownership action.

import { can, type Role } from "../sharing/roles";
import type { Anchor } from "./annotation";

/**
 * Persistence port — thin Drizzle glue. `dismiss` stamps `dismissed_at` (the soft, kept
 * tombstone that excludes from the active list); `reattach` clears `is_orphaned` and writes
 * the fresh anchor. Kept a port so the authz stays unit-testable without a DB (mirrors
 * DeleteRepo/RestoreRepo).
 */
export interface DismissReattachRepo {
  /** S-008 / C-013 / AS-023: soft-dismiss — stamp `dismissed_at` to now (the row is kept). */
  dismiss(annotationId: string): Promise<void>;
  /** S-008 / C-013 / AS-024: re-attach — clear `is_orphaned` and set the fresh anchor. */
  reattach(annotationId: string, anchor: Anchor): Promise<void>;
}

/**
 * Whether the submitted anchor places against the current version content. The route passes
 * a concrete checker built from the re-anchor matcher (reanchorAnnotation): an anchor whose
 * block/snippet no current block matches returns false → the route refuses with 400 (AS-024
 * "a range I select in the CURRENT version"). Injectable so the pure functions stay DB-free.
 */
export type AnchorPlaces = (anchor: Anchor) => boolean;

export interface DismissAnnotationInput {
  annotationId: string;
  /** The caller's effective doc-scoped role, resolved SERVER-side from the session. */
  sessionRole: Role;
}

export type DismissAnnotationResult = { ok: true } | { ok: false; reason: "forbidden" };

/**
 * Decide whether the caller may dismiss the detached annotation, and soft-dismiss on allow
 * (S-008 / C-013 / AS-023). Authz: comment permission or higher — `can(sessionRole, "comment")`
 * (viewer is the only role without it, AS-025). A viewer is refused; the repo is never written,
 * so the annotation is untouched.
 */
export async function dismissAnnotation(
  input: DismissAnnotationInput,
  repo: DismissReattachRepo,
): Promise<DismissAnnotationResult> {
  if (!can(input.sessionRole, "comment")) {
    return { ok: false, reason: "forbidden" }; // viewer → refused (AS-025)
  }
  await repo.dismiss(input.annotationId);
  return { ok: true };
}

export interface ReattachAnnotationInput {
  annotationId: string;
  /** The fresh range the caller selected in the current version (validated by the route's Zod). */
  anchor: Anchor;
  /** The caller's effective doc-scoped role, resolved SERVER-side from the session. */
  sessionRole: Role;
}

export type ReattachAnnotationResult =
  | { ok: true }
  | { ok: false; reason: "forbidden" }
  | { ok: false; reason: "anchor_mismatch" };

/**
 * Decide whether the caller may re-attach the detached annotation onto the submitted range,
 * and clear `is_orphaned` + set the fresh anchor on allow (S-008 / C-013 / AS-024).
 *
 * Order matters: the COMMENT-permission gate runs FIRST (a viewer must be refused BEFORE we
 * reveal whether their anchor would have matched — AS-025: "the annotation is unchanged"),
 * THEN the anchor-placement check (AS-024: the range must be in the current version). Only when
 * both pass is the re-attach written.
 *   - viewer (no comment) → forbidden (the repo is never written).
 *   - anchor doesn't place against the current content → anchor_mismatch (→ 400; unchanged).
 */
export async function reattachAnnotation(
  input: ReattachAnnotationInput,
  anchorPlaces: AnchorPlaces,
  repo: DismissReattachRepo,
): Promise<ReattachAnnotationResult> {
  if (!can(input.sessionRole, "comment")) {
    return { ok: false, reason: "forbidden" }; // viewer → refused, BEFORE any anchor work (AS-025)
  }
  if (!anchorPlaces(input.anchor)) {
    return { ok: false, reason: "anchor_mismatch" }; // not a range in the current version (AS-024)
  }
  await repo.reattach(input.annotationId, input.anchor);
  return { ok: true };
}
