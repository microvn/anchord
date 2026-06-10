// GAP-001 (resolved): TanStack Query keys are SCOPED BY workspaceId so switching the active
// workspace never shows another workspace's cached data. Two workspaces produce two divergent
// key trees — no manual cache invalidation needed; the active workspace's route param drives
// which key (and therefore which cached slice) a screen reads. (C-001, AS-002)
//
// The bootstrap (`/api/me`) is workspace-AGNOSTIC (it lists ALL my workspaces), so it gets its
// own un-scoped key. Everything else (members, projects, docs…) hangs off `ws(id)` so it is
// physically impossible to read workspace A's members under workspace B's key.

export const queryKeys = {
  /** The bootstrap: who I am + every workspace I belong to + the active one. Not workspace-scoped. */
  bootstrap: () => ["bootstrap"] as const,

  /** Root for everything scoped to ONE workspace. Switching workspaceId yields a disjoint subtree. */
  ws: (workspaceId: string) => ["w", workspaceId] as const,

  /** The member directory + pending invites for ONE workspace (S-003). */
  members: (workspaceId: string) => ["w", workspaceId, "members"] as const,

  /** The projects list for ONE workspace (workspace-project S-003). */
  projects: (workspaceId: string) => ["w", workspaceId, "projects"] as const,

  /** The docs in ONE project (workspace-project S-003 / AS-006). */
  projectDocs: (workspaceId: string, projectId: string) =>
    ["w", workspaceId, "projects", projectId, "docs"] as const,

  /** All docs in ONE workspace — the union across the workspace's projects (browse). */
  docs: (workspaceId: string) => ["w", workspaceId, "docs"] as const,

  /** A search run in ONE workspace, keyed by the query text (workspace-project S-005). */
  search: (workspaceId: string, q: string) => ["w", workspaceId, "search", q] as const,
};
