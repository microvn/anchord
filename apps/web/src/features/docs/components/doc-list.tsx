import { Link } from "react-router-dom";
import { FormatBadge, FormatTag, MetaDot, VersionTag, AnnotationCount, StatusTag } from "./doc-bits";
import { DocMoreMenu } from "./move-copy-dialog";
import type { DocRow, ProjectRow } from "@/features/docs/types";

// The "Documents · Recent" list rows on the dashboard + the All-docs list view, 1:1 with
// Anchord-Design's DocList (.list wrapper of .doc-row). Each row is COLUMNAR
// (grid 30px 1fr 70px 96px 96px, the design's exact track sizes):
//   [format glyph] · (title + "FORMAT · project · author" subline) · version · ✎ annotations · status
// All columns are real: version + annotationCount + authorName + status now come from the
// docs-list endpoint. On narrow widths the version + annotation columns drop (design @720px).

export function DocList({
  docs,
  workspaceId,
  projects,
}: {
  docs: DocRow[];
  // Required: every in-app list is workspace-scoped, so a row ALWAYS opens the in-app React viewer
  // `/w/:workspaceId/d/:slug` — never the bare `/d/:slug` server page. Making this required stops a
  // caller silently falling back to the server page (the "click → broken viewer" bug).
  workspaceId: string;
  projects?: ProjectRow[];
}) {
  return (
    <div
      data-testid="doc-list"
      className="overflow-hidden rounded-[11px] border border-line bg-surface"
    >
      {docs.map((d) => (
        <Link
          key={d.id}
          // annotation-core-ui S-001: always the in-app React viewer route (workspace-scoped).
          to={`/w/${workspaceId}/d/${d.slug}`}
          data-testid={`doc-row-${d.slug}`}
          className="grid min-h-[56px] grid-cols-[30px_1fr_auto_auto] items-center gap-[14px] border-b border-line px-4 text-inherit no-underline last:border-b-0 hover:bg-elev sm:grid-cols-[30px_1fr_70px_96px_96px]"
        >
          <FormatBadge kind={d.kind} />
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold text-ink">{d.title}</div>
            <div className="mt-0.5 flex items-center gap-[7px] text-[11.5px] text-subtle">
              <FormatTag kind={d.kind} />
              {d.projectName && (
                <>
                  <MetaDot />
                  <span className="truncate">{d.projectName}</span>
                </>
              )}
              {d.authorName && (
                <>
                  <MetaDot />
                  <span className="truncate">{d.authorName}</span>
                </>
              )}
            </div>
          </div>
          {/* version — hidden below sm (design @720px), like .doc-updated-cell. */}
          <span className="hidden justify-self-start sm:block">
            <VersionTag version={d.version} />
          </span>
          {/* annotations — hidden below sm. */}
          <span className="hidden justify-end sm:flex">
            <AnnotationCount count={d.annotationCount} />
          </span>
          {/* status — always visible, right-aligned; the ⋯ menu rides alongside it. */}
          <span className="flex items-center justify-end gap-1">
            <StatusTag status={d.status} />
            {workspaceId && projects && (
              <DocMoreMenu
                doc={d}
                workspaceId={workspaceId}
                projects={projects}
                canDelete={d.canDelete ?? false}
              />
            )}
          </span>
        </Link>
      ))}
    </div>
  );
}
