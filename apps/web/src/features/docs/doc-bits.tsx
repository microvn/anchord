import { Icon } from "../../components/icon";
import { FORMAT_META, type DocKind } from "./types";

// Shared presentational bits for the doc browse surfaces, 1:1 with Anchord-Design's
// FormatBadge / .doc-fmt / .doc-fmt-tag. Only metadata the backend actually returns is
// shown: the format chip (kind) + the mono format tag. Richer DocCard fields in the design
// (version, author, access, detached, commentCount) have no mounted endpoint yet, so they
// are intentionally absent here rather than faked.

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
