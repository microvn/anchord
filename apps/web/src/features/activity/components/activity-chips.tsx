import { Icon } from "@/components/icon";
import type { ActivityEventRow } from "@/features/activity/types";

// Type-specific footer chips for a feed row (workspace-activity S-001 — the `ActivityChips`
// presentational piece from the export contract). Dense metadata: the doc, the project, and
// per-type meta (publish from→to + add/remove, restore, detached count, resolve, share access).
//
// Everything rendered here is PLAIN TEXT (React escapes it) — actorName/summary/target/doc and the
// meta fields are never dangerouslySetInnerHTML (F-12 / guest-name defence-in-depth). S-001 emits
// only comment/reply/resolve, but the chips cover all twelve types so later stories' rows render
// without re-touching this component.

interface Meta {
  from?: string;
  to?: string;
  adds?: number;
  dels?: number;
  restored?: string;
  as?: string;
  count?: number;
  access?: string;
  role?: string;
  pending?: boolean;
}

export function ActivityChips({ event }: { event: ActivityEventRow }) {
  const m = (event.meta ?? {}) as Meta;
  const chips: React.ReactNode[] = [];

  // The doc the event targets (shown as a chip except for publish/restore, where the sentence
  // already names the doc as the target). target carries the doc title for doc-scoped events.
  if (event.target && event.type !== "publish" && event.type !== "restore") {
    chips.push(
      <span key="doc" className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] text-muted">
        <Icon name="docs" size={11} />
        {event.target}
      </span>,
    );
  }

  if (event.type === "publish" && (m.from || m.to)) {
    chips.push(
      <span key="v" className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] text-muted tabular-nums">
        {m.from} → {m.to}
        {m.adds != null && <span className="text-success">+{m.adds}</span>}
        {m.dels != null && <span className="text-error">−{m.dels}</span>}
      </span>,
    );
  }
  if (event.type === "restore" && m.restored) {
    chips.push(
      <span key="r" className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] text-amber">
        <Icon name="refresh" size={11} />
        {m.restored} → {m.as}
      </span>,
    );
  }
  if (event.type === "detached" && m.count != null) {
    chips.push(
      <span key="dt" className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] text-amber">
        <Icon name="alert" size={11} />
        {m.count} detached
      </span>,
    );
  }
  if (event.type === "resolve") {
    chips.push(
      <span key="rs" className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] text-success">
        <Icon name="check" size={11} />
        Resolved
      </span>,
    );
  }
  if (event.type === "share" && m.access) {
    chips.push(
      <span key="sh" className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] text-muted">
        <Icon name="link" size={11} />
        {m.access}
      </span>,
    );
  }
  if (m.role) {
    chips.push(
      <span key="rl" className="inline-flex items-center rounded-md border border-line bg-surface px-2 py-0.5 text-[11.5px] text-muted">
        {m.role}
        {m.pending ? " · pending" : ""}
      </span>,
    );
  }

  if (chips.length === 0) return null;
  return <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{chips}</div>;
}
