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
  /** Filled in by the workspace docs aggregator: the project this doc belongs to. */
  projectId?: string;
  /** The project's display name (joined client-side from the projects list). */
  projectName?: string;
}

/** One project as the list endpoint returns it (GET …/projects → data.projects[]). */
export interface ProjectRow {
  id: string;
  name: string;
  isDefault: boolean;
  archived: boolean;
  /** Doc count — derived client-side by counting the project's browse-visible docs. */
  docCount?: number;
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
}

/** The format chip label + Anchord-Design icon for a doc kind. */
export const FORMAT_META: Record<DocKind, { label: string; icon: string }> = {
  markdown: { label: "MD", icon: "docs" },
  html: { label: "HTML", icon: "link" },
  image: { label: "IMG", icon: "docs" },
};

/** The per-card access indicator label + Anchord-Design icon for a general-access level
 *  (S-006/AS-018). restricted → shield; anyone_in_workspace → people; anyone_with_link → link. */
export const ACCESS_META: Record<GeneralAccess, { label: string; icon: string }> = {
  restricted: { label: "Restricted", icon: "shield" },
  anyone_in_workspace: { label: "Workspace", icon: "members" },
  anyone_with_link: { label: "Link", icon: "link" },
};
