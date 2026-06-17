import { Icon } from "@/components/icon";
import { FORMAT_META, type DocKind, type DocStatus } from "@/features/docs/types";

// Shared presentational bits for the doc browse surfaces, 1:1 with Anchord-Design's
// FormatBadge / .doc-fmt / .doc-fmt-tag + the columnar row cells (.doc-ver / .doc-comments /
// .status-tag). The docs-list endpoint now returns version + annotationCount + authorName +
// status, so these columns carry real values.

/** The teal rounded format glyph (Anchord-Design `.doc-fmt` / `.doc-card-fmt`). */
export function FormatBadge({ kind, size = 30 }: { kind: DocKind; size?: number }) {
  const meta = FORMAT_META[kind] ?? FORMAT_META.markdown;
  return (
    <span
      className="grid flex-none place-items-center rounded-md bg-accent-soft text-accent-ink"
      style={{ width: size, height: size }}
      title={meta.label}
    >
      <Icon name={meta.icon} size={Math.round(size / 2)} />
    </span>
  );
}

/** The mono uppercase format tag shown beside a doc title in list rows (`.doc-fmt-tag`). */
export function FormatTag({ kind }: { kind: DocKind }) {
  const meta = FORMAT_META[kind] ?? FORMAT_META.markdown;
  return (
    <span className="font-mono text-[9.5px] uppercase tracking-[0.06em] text-muted">
      {meta.label}
    </span>
  );
}

/** A small grey dot separator (Anchord-Design `.dot`). */
export function MetaDot() {
  return <span className="size-[3px] flex-none rounded-full bg-faint" aria-hidden="true" />;
}

/** The mono version cell (`v4`), `.doc-ver`. Shows `v0` style only when something is published. */
export function VersionTag({ version }: { version: number }) {
  return (
    <span className="font-mono text-[12.5px] tabular-nums text-muted">{version > 0 ? `v${version}` : "—"}</span>
  );
}

/**
 * The active-annotation-count cell, `.doc-comments`. Faint when zero. Shows the doc's
 * ACTIVE-annotation count (workspace-project-ui S-007 / C-006) beside an ANNOTATION icon
 * (the pencil glyph) — never an envelope/comment/mail icon: the count is annotations, not
 * the comment total across threads.
 */
export function AnnotationCount({ count }: { count: number }) {
  return (
    <span
      className={`inline-flex items-center gap-[5px] text-[12.5px] tabular-nums ${count > 0 ? "text-muted" : "text-faint"}`}
    >
      <Icon name="pencil" size={13} />
      {count}
    </span>
  );
}

/** The mono status pill (● LIVE / DRAFT), `.status-tag`. Live = green dot+ink; draft = faint. */
export function StatusTag({ status }: { status: DocStatus }) {
  const live = status === "live";
  return (
    <span
      className={`inline-flex items-center gap-[5px] font-mono text-[9.5px] font-medium uppercase tracking-[0.08em] ${live ? "text-success" : "text-subtle"}`}
    >
      <span className={`size-[6px] rounded-full ${live ? "bg-success" : "bg-faint"}`} aria-hidden="true" />
      {live ? "Live" : "Draft"}
    </span>
  );
}
