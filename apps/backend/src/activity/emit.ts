// Best-effort post-commit activity emit (workspace-activity S-001, C-002 / C-008).
//
// The single seam every mutation site calls to append ONE activity row AFTER its own write has
// committed. Mirrors the notify best-effort shape (src/notify/notify.ts): the whole pass is
// wrapped so a throwing repo / resolver is logged and SWALLOWED — a logging failure NEVER blocks
// or rolls back the originating mutation; the only consequence is one missing feed entry (C-002,
// AS-006). The caller awaits it but ignores its outcome for the response.
//
// C-008 cross-workspace isolation: for a DOC-scoped event the workspaceId is resolved from the
// target doc's project → workspace (via the injected `workspaceOfDoc`), never trusted from the
// caller's path — so a row's workspaceId always matches the doc's real owner. A workspace-level
// event (no doc) passes `workspaceId` directly.
//
// actorName resolution: the session carries only `userId`. The emit resolves the display name
// per-emit via the injected `resolveActorName` (a cheap lookup, acceptable under best-effort).
// A System actor (null userId, e.g. the detached event, S-005) carries "System"; a guest carries
// the guest-supplied name passed by the caller. actorName is stored + rendered as PLAIN TEXT.

import type { ActivityRepo, NewActivity } from "./repo";
import type { ActivityType } from "./types";

/** The hard-coded display name for the System actor (no account — e.g. detach, S-005). */
export const SYSTEM_ACTOR_NAME = "System";

/** Ports the emit needs — injected so the seam is unit-testable without a DB. */
export interface ActivityEmitDeps {
  repo: ActivityRepo;
  /**
   * The doc's OWN workspace (docs.project_id → projects.workspace_id), or null when it can't be
   * resolved (a project-less / vanished doc). C-008: the row's workspaceId is anchored to this,
   * never the caller's path. Required for a doc-scoped emit; unused when `workspaceId` is given.
   */
  workspaceOfDoc?: (docId: string) => Promise<string | null>;
  /**
   * Resolve an account user's display name (user.name). Null when absent. Used when the emit
   * carries a userId but no explicit actorName.
   */
  resolveActorName?: (userId: string) => Promise<string | null>;
  /** Optional structured logger for best-effort failures (defaults to console.error). */
  logError?: (msg: string, err: unknown) => void;
}

/** The event a mutation site asks to log. Exactly one of `docId` / `workspaceId` anchors the row. */
export interface EmitActivityInput {
  type: ActivityType;
  /**
   * The acting account user id, or null for the System actor / a guest (no account). When set and
   * no `actorName` is provided, the name is resolved via `resolveActorName`.
   */
  actorUserId: string | null;
  /**
   * An explicit display name — wins over `resolveActorName`. Pass the guest's supplied name for a
   * guest action, or omit for an account actor (then it is resolved from `actorUserId`). A null
   * actor with no name falls back to "System".
   */
  actorName?: string | null;
  /**
   * The target DOC — when set, the row's workspaceId is resolved from this doc's project → workspace
   * (C-008). A doc-scoped event (comment/reply/resolve/publish/restore/share/detached) sets this.
   */
  docId?: string | null;
  /**
   * The OWNING workspace, set DIRECTLY for a workspace-level event (invite/member/member_removed/
   * workspace_renamed/project — no doc target). Wins over `workspaceOfDoc` when present.
   */
  workspaceId?: string | null;
  projectId?: string | null;
  versionId?: string | null;
  commentId?: string | null;
  annotationId?: string | null;
  summary?: string | null;
  target?: string | null;
  meta?: unknown;
}

/**
 * Append ONE activity row, best-effort (C-002). Resolves the owning workspaceId (C-008) and the
 * actorName, then inserts. Returns the new row's id on success, or null when nothing was written
 * (resolution failed, or a thrown repo/resolver was swallowed) — the caller ignores the result.
 *
 * NEVER throws: a doc with no resolvable workspace, a throwing repo, or a failed name lookup all
 * resolve to a logged no-op so the originating mutation is untouched (AS-006).
 */
export async function emitActivity(
  input: EmitActivityInput,
  deps: ActivityEmitDeps,
): Promise<{ id: string } | null> {
  const log = deps.logError ?? ((msg, err) => console.error(msg, err));
  try {
    // C-008: anchor the workspaceId. A workspace-level event passes it directly; a doc-scoped
    // event resolves it from the doc's OWN workspace (never the caller's path).
    let workspaceId = input.workspaceId ?? null;
    if (workspaceId == null && input.docId != null && deps.workspaceOfDoc) {
      workspaceId = await deps.workspaceOfDoc(input.docId);
    }
    if (workspaceId == null) {
      // No owning workspace (project-less / vanished doc, or a missing resolver) → cannot place the
      // row in a feed. Best-effort: skip (one missing entry), never throw (C-002).
      log("emitActivity skipped — no resolvable workspaceId", { type: input.type, docId: input.docId });
      return null;
    }

    // Resolve actorName: explicit name wins; else look up the account user's name; else "System".
    let actorName = input.actorName ?? null;
    if (actorName == null && input.actorUserId != null && deps.resolveActorName) {
      actorName = await deps.resolveActorName(input.actorUserId);
    }
    if (actorName == null || actorName.length === 0) actorName = SYSTEM_ACTOR_NAME;

    const row: NewActivity = {
      workspaceId,
      type: input.type,
      actorUserId: input.actorUserId,
      actorName,
      docId: input.docId ?? null,
      projectId: input.projectId ?? null,
      versionId: input.versionId ?? null,
      commentId: input.commentId ?? null,
      annotationId: input.annotationId ?? null,
      summary: input.summary ?? null,
      target: input.target ?? null,
      meta: input.meta ?? null,
    };
    return await deps.repo.insertActivity(row);
  } catch (err) {
    // Post-commit best-effort: log + swallow so the mutation still succeeds (C-002 / AS-006).
    log("emitActivity failed (best-effort, mutation already persisted)", err);
    return null;
  }
}
