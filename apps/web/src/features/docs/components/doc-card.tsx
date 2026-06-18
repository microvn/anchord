import { Link } from "react-router-dom";
import {
  FormatBadge,
  MetaDot,
  VersionTag,
  AnnotationCount,
  AccessIndicator,
  StatusTag,
} from "./doc-bits";
import { DocMoreMenu } from "./move-copy-dialog";
import { FORMAT_META, type DocRow, type ProjectRow } from "@/features/docs/types";

// DocCard — the grid tile in the All-docs browser, 1:1 with Anchord-Design's DocCard
// (.doc-card: top row [format glyph · ver · ⋯], body [title · project · author], foot
// [format label · spacer · ✎ annotations · status]). Version/annotationCount/author/status now
// come from the docs-list endpoint, so the card carries real metadata. When `workspaceId` +
// `projects` are supplied (the browse screen), a ⋯ more-menu offers Move / Copy (S-001).

export function DocCard({
  doc,
  workspaceId,
  projects,
}: {
  doc: DocRow;
  // Required: a card always opens the in-app React viewer `/w/:workspaceId/d/:slug`, never the bare
  // `/d/:slug` server page. Required so a caller can't silently fall back to the broken server page.
  workspaceId: string;
  projects?: ProjectRow[];
}) {
  const meta = FORMAT_META[doc.kind] ?? FORMAT_META.markdown;
  // annotation-core-ui S-001: open in the in-app React viewer (workspace-scoped route).
  const href = `/w/${workspaceId}/d/${doc.slug}`;
  return (
    <Link
      to={href}
      data-testid={`doc-card-${doc.slug}`}
      className="flex flex-col overflow-hidden rounded-[11px] border border-line bg-surface text-inherit no-underline transition-[border-color,box-shadow,transform] duration-100 hover:-translate-y-px hover:border-subtle hover:shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
    >
      <div className="flex items-center gap-[9px] px-[14px] pt-[13px]">
        <FormatBadge kind={doc.kind} />
        <VersionTag version={doc.version} />
        <span className="ml-auto font-mono text-[12.5px] uppercase tracking-[0.06em] text-muted">
          {meta.label}
        </span>
        {workspaceId && projects && (
          <DocMoreMenu doc={doc} workspaceId={workspaceId} projects={projects} />
        )}
      </div>
      <div className="flex-1 px-[14px] pb-[11px] pt-[11px]">
        <div className="text-[15px] font-semibold leading-[1.3] text-ink">{doc.title}</div>
        {(doc.projectName || doc.authorName) && (
          <div className="mt-[5px] flex items-center gap-[7px] text-[11.5px] text-subtle">
            {doc.projectName && <span className="truncate">{doc.projectName}</span>}
            {doc.projectName && doc.authorName && <MetaDot />}
            {doc.authorName && <span className="truncate">{doc.authorName}</span>}
          </div>
        )}
      </div>
      {/* Foot tier — 1:1 with Anchord-Design `.doc-card-foot`: a distinct raised band (bg-elev) with
          a top border; access indicator on the left, annotation count + status pushed right. */}
      <div className="flex flex-wrap items-center gap-[8px] border-t border-line bg-elev px-[14px] py-[9px]">
        <AccessIndicator access={doc.generalAccess} />
        <span className="ml-auto" aria-hidden="true" />
        <AnnotationCount count={doc.annotationCount} />
        <StatusTag status={doc.status} />
      </div>
    </Link>
  );
}
