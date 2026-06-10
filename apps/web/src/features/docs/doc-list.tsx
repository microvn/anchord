import { Link } from "react-router-dom";
import { FormatBadge, FormatTag, MetaDot } from "./doc-bits";
import type { DocRow } from "./types";

// The "Documents · Recent" list rows on the dashboard, 1:1 with Anchord-Design's DocList
// (.list wrapper of .doc-row). Each row: teal format glyph · title + (FormatTag · project)
// meta · → the doc viewer (/d/:slug, the trusted app-origin shell the backend serves).
// Version/comments/status columns from the design are omitted — no mounted endpoint
// exposes those fields yet (see features/docs/types.ts).

export function DocList({ docs }: { docs: DocRow[] }) {
  return (
    <div
      data-testid="doc-list"
      className="overflow-hidden rounded-[11px] border border-line bg-surface"
    >
      {docs.map((d) => (
        <Link
          key={d.id}
          to={`/d/${d.slug}`}
          data-testid={`doc-row-${d.slug}`}
          className="grid min-h-[56px] grid-cols-[30px_1fr] items-center gap-[14px] border-b border-line px-4 text-inherit no-underline last:border-b-0 hover:bg-elev"
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
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
