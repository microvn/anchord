import { Icon } from "@/components/icon";
import { versionLabel } from "@/features/activity/components/publish-diff-mini";
import type { ActivityEventRow } from "@/features/activity/types";

// Type-specific footer chips for a feed row (workspace-activity S-001 — the `ActivityChips`
// presentational piece from the export contract). Dense metadata: the doc, the project, and
// per-type meta (publish from→to + add/remove, restore, detached count, resolve, share access).
//
// Visual: mirrors activity.css .act-chip — MONO 10px, filled bg-elev, the doc chip in accent-ink,
// amber/green variants filled (no border). Everything rendered here is PLAIN TEXT (React escapes
// it) — never dangerouslySetInnerHTML (F-12 / guest-name defence-in-depth). S-001 emits only
// comment/reply/resolve, but the chips cover all twelve types so later stories render unchanged.

interface Meta {
  from?: number | string;
  to?: number | string;
  adds?: number;
  dels?: number;
  restored?: number | string;
  as?: number | string;
  count?: number;
  access?: string;
  role?: string;
  pending?: boolean;
  thread?: "open" | "resolved";
  replies?: number;
}

// .act-chip base + tone variants (activity.css).
const CHIP = "inline-flex items-center gap-1.5 rounded-md border px-[7px] py-0.5 font-mono text-[10px] [&_svg]:text-subtle";
const CHIP_TONE = {
  default: "border-line bg-elev text-muted",
  doc: "border-line bg-elev text-accent-ink",
  amber: "border-transparent bg-amber-bg text-amber",
  green: "border-transparent bg-success/15 text-success",
} as const;

export function ActivityChips({ event }: { event: ActivityEventRow }) {
  const m = (event.meta ?? {}) as Meta;
  const chips: React.ReactNode[] = [];

  // The doc chip (accent) — the document the event belongs to. Prefer the read-enriched docTitle;
  // fall back to target for legacy rows where target carried the doc title.
  const docName = event.docTitle ?? (event.type !== "publish" && event.type !== "restore" ? event.target : null);
  if (docName) {
    chips.push(
      <span key="doc" className={`${CHIP} ${CHIP_TONE.doc}`}>
        <Icon name="docs" size={11} />
        {docName}
      </span>,
    );
  }

  // The project chip (.act-chip with a folder icon) — dense metadata, mirrors the prototype.
  if (event.projectName) {
    chips.push(
      <span key="p" className={`${CHIP} ${CHIP_TONE.default}`}>
        <Icon name="folder" size={11} />
        {event.projectName}
      </span>,
    );
  }

  if (event.type === "publish" && (m.from != null || m.to != null)) {
    chips.push(
      <span key="v" className={`${CHIP} ${CHIP_TONE.default} tabular-nums`}>
        {versionLabel(m.from)} → {versionLabel(m.to)}
        {m.adds != null && <span className="text-success">+{m.adds}</span>}
        {m.dels != null && <span className="text-error">−{m.dels}</span>}
      </span>,
    );
  }
  if (event.type === "restore" && m.restored != null) {
    chips.push(
      <span key="r" className={`${CHIP} ${CHIP_TONE.amber}`}>
        <Icon name="refresh" size={11} />
        {versionLabel(m.restored)} → {versionLabel(m.as)}
      </span>,
    );
  }
  if (event.type === "detached" && m.count != null) {
    chips.push(
      <span key="dt" className={`${CHIP} ${CHIP_TONE.amber}`}>
        <Icon name="alert" size={11} />
        {m.count} detached
      </span>,
    );
  }
  if (event.type === "resolve") {
    chips.push(
      <span key="rs" className={`${CHIP} ${CHIP_TONE.green}`}>
        <Icon name="check" size={11} />
        Resolved
      </span>,
    );
  }
  if (m.thread === "open") {
    chips.push(
      <span key="th" className={`${CHIP} ${CHIP_TONE.default}`}>
        <Icon name="inbox" size={11} />
        {m.replies ? `${m.replies} ${m.replies > 1 ? "replies" : "reply"}` : "Open"}
      </span>,
    );
  }
  if (event.type === "share" && m.access) {
    chips.push(
      <span key="sh" className={`${CHIP} ${CHIP_TONE.default}`}>
        <Icon name="link" size={11} />
        {m.access}
      </span>,
    );
  }
  if (m.role) {
    chips.push(
      <span key="rl" className={`${CHIP} ${CHIP_TONE.default}`}>
        {m.role}
        {m.pending ? " · pending" : ""}
      </span>,
    );
  }

  if (chips.length === 0) return null;
  return <div className="mt-2 flex flex-wrap items-center gap-2">{chips}</div>;
}
