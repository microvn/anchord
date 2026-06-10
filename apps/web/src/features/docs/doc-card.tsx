import { Link } from "react-router-dom";
import { FormatBadge, MetaDot } from "./doc-bits";
import { FORMAT_META, type DocRow } from "./types";

// DocCard — the grid tile in the All-docs browser, 1:1 with Anchord-Design's DocCard
// (.doc-card: top row [format glyph · ver · more], body [title · project], foot [access …
// comments · status]). The design's version/access/detached/comments/status come from
// fields no mounted endpoint returns yet, so the card shows what the backend gives:
// the format glyph + title + project name. The foot carries the mono format label.

export function DocCard({ doc }: { doc: DocRow }) {
  const meta = FORMAT_META[doc.kind] ?? FORMAT_META.markdown;
  return (
    <Link
      to={`/d/${doc.slug}`}
      data-testid={`doc-card-${doc.slug}`}
      className="flex flex-col overflow-hidden rounded-[11px] border border-line bg-surface text-inherit no-underline transition-[border-color,box-shadow,transform] duration-100 hover:-translate-y-px hover:border-subtle hover:shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
    >
      <div className="flex items-center gap-[9px] px-[14px] pt-[13px]">
        <FormatBadge kind={doc.kind} />
        <span className="ml-auto font-mono text-[12.5px] uppercase tracking-[0.06em] text-muted">
          {meta.label}
        </span>
      </div>
      <div className="flex-1 px-[14px] pb-[13px] pt-[11px]">
        <div className="text-[15px] font-semibold leading-[1.3] text-ink">{doc.title}</div>
        {doc.projectName && (
          <div className="mt-[5px] flex items-center gap-[7px] text-[11.5px] text-subtle">
            <MetaDot />
            <span className="truncate">{doc.projectName}</span>
          </div>
        )}
      </div>
    </Link>
  );
}
