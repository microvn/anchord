// Shapes the workspace-project browse UI consumes from the backend (Linked Fields).
// These mirror the EXACT wire shapes the mounted routes return — read
// apps/backend/src/routes/{projects,docs,search}.ts. We deliberately model ONLY the
// fields the backend actually exposes today; the Anchord-Design DocCard shows richer
// metadata (version/author/access/detached/annotationCount) that no mounted endpoint
// surfaces yet, so those are rendered when present and omitted otherwise (never faked).

/** A doc's source format. Backend field is `kind`; the design calls the chip a "format". */
export type DocKind = "html" | "markdown" | "image";

/** A doc's published state, derived from general_access on the backend. */
export type DocStatus = "live" | "draft";

/** A doc's general-access level (who can reach it without an explicit per-doc role). */
export type GeneralAccess = "restricted" | "anyone_in_workspace" | "anyone_with_link";

/** A project's visibility (project-visibility S-003). private = owner-only group; public = visible to
 *  the workspace. The FE NEVER computes this — it renders the server's `visibility` value (C-001). */
export type ProjectVisibility = "private" | "public";

/** A doc as the project-docs browse endpoint returns it (GET …/projects/:id/docs → data.docs[]). */
export interface DocRow {
  id: string;
  slug: string;
  title: string;
  kind: DocKind;
  /** Highest published version number (0 when nothing is published yet). */
  version: number;
  /** Active annotation count (annotations whose soft-delete tombstone is unset). */
  annotationCount: number;
  /** The first-publisher's display name (null for a seeded/owner-less doc). */
  authorName: string | null;
  /** live (shared beyond restricted) / draft (restricted). */
  status: DocStatus;
  /** The raw general-access level — drives the per-card AccessIndicator (S-006/AS-018).
   *  `status` collapses link vs workspace into "live"; this keeps the 3-way distinction. */
  generalAccess: GeneralAccess;
  /** doc-delete-trash S-001 / C-003: server-computed — may the current caller delete this doc
   *  (owner/editor OR workspace-admin)? Drives the ⋯-menu Delete item. Absent on legacy/mocked
   *  rows → treated as false (Delete hidden). */
  canDelete?: boolean;
  /** Filled in by the workspace docs aggregator: the project this doc belongs to. */
  projectId?: string;
  /** The project's display name (joined client-side from the projects list). */
  projectName?: string;
  /** ISO timestamp the doc was created (served by workspace-project:AS-022). Drives the Created
   *  sort + the Updated facet. Optional so a legacy/mocked row without it degrades gracefully. */
  createdAt?: string;
  /** ISO timestamp the doc was last updated (served by workspace-project:AS-022). The default sort
   *  key and the Updated facet read it. */
  updatedAt?: string;
}

/** One project as the list endpoint returns it (GET …/projects → data.projects[]). */
export interface ProjectRow {
  id: string;
  name: string;
  isDefault: boolean;
  archived: boolean;
  /** Doc count — derived client-side by counting the project's browse-visible docs. */
  docCount?: number;
  /** project-visibility S-003 / AS-001 / C-001: the project's visibility, served on each list row.
   *  Drives the Private/Public badge. Optional so a legacy/mocked row without it degrades (no badge). */
  visibility?: ProjectVisibility;
  /** project-visibility S-003 / AS-003 / C-003: server-computed — may the current caller toggle THIS
   *  project's visibility (owner always; admin only on a project they can see)? Drives the ⋯-menu
   *  toggle affordance. The FE renders the toggle iff true and NEVER re-derives the gate (C-003).
   *  Absent on legacy/mocked rows → treated as false (toggle hidden). */
  canToggleVisibility?: boolean;
  /** project-visibility-fe S-002 / AS-008 / C-001: the server-derived access level a NEW doc created
   *  in this project would get — `anyone_in_workspace` for a public OR the default private-shell
   *  project (the carve-out), `restricted` for a non-default private one. The new-doc hint DISPLAYS
   *  this value; the FE NEVER recomputes the carve-out. Absent on legacy/mocked rows → no hint. */
  newDocAccess?: GeneralAccess;
}

/** A search hit (GET …/search?q= → data.results[]). matchSource drives the "in title/content/comment" tag. */
export interface SearchResultRow {
  docId: string;
  slug: string;
  title: string;
  kind: DocKind;
  matchSource: "title" | "content" | "comment";
}

/** The publish result (POST …/docs → data). */
export interface PublishResult {
  docId: string;
  slug: string;
  url: string;
  /** project-visibility-fe S-004 / AS-016 / C-001: the project the doc landed in, as the publish
   *  response reports it (web publish AND MCP create — project-visibility:AS-029). NULLABLE, and
   *  `name` may itself be null; the PublishAccessNotice renders it null-safe (AS-017). The FE reads
   *  this — it never computes where the doc landed. */
  project?: { id: string; name: string | null } | null;
  /** project-visibility-fe S-004 / AS-016 / C-001: the doc's resulting general-access level
   *  (the server's `deriveLevel` string), shown in the publish notice. Absent or unrecognized →
   *  the access clause is omitted (AS-017). The FE displays this; it never derives access. */
  access?: GeneralAccess;
}

/** The format chip label + Anchord-Design icon + label tone for a doc kind. `tone` tints the
 *  format label so the three kinds read apart at a glance, using design tokens only:
 *  MD→blue, HTML→amber, IMG→success(green). All three reuse DESIGN.md hues (Pinpoint blue /
 *  amber / Like green); accent(teal) and error(red) stay reserved. */
export const FORMAT_META: Record<DocKind, { label: string; icon: string; tone: string }> = {
  markdown: { label: "MD", icon: "docs", tone: "text-blue" },
  html: { label: "HTML", icon: "code", tone: "text-amber" },
  image: { label: "IMG", icon: "image", tone: "text-success" },
};

/** The per-card access indicator label + Anchord-Design icon for a general-access level
 *  (S-006/AS-018). restricted → shield; anyone_in_workspace → people; anyone_with_link → link. */
export const ACCESS_META: Record<GeneralAccess, { label: string; icon: string }> = {
  restricted: { label: "Restricted", icon: "shield" },
  anyone_in_workspace: { label: "Workspace", icon: "members" },
  anyone_with_link: { label: "Link", icon: "link" },
};
