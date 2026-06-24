import { Icon } from "@/components/icon";
import { relativeTime } from "@/features/notifications/lib/format";
import { ActivityChips } from "@/features/activity/components/activity-chips";
import { actionNodeFor, NODE_TONE_CLASS } from "@/features/your-activity/lib/node-style";
import type { ActivityRowMeta } from "@/features/activity/types";
import type { MyActivityRow } from "@/features/your-activity/types";

// your-activity-actions S-001 — one "Your actions" row in the PERSONAL family (Anchord-Design
// `.me-row`), NOT the workspace timeline row. Per C-007 (reversed): the personal Your-actions list
// must match the prototype's `personal.css .me-row` — a grid `8px 34px 1fr`, a TRANSPARENT unread
// dot (own actions are never "unread"), a 34px node TONED BY TYPE (no actor avatar), a VERB-FIRST
// sentence (no actor name), an optional quote + preview, the reused `<ActivityChips>`, and a mono
// time pushed right. Clicking opens the detail in place.

/**
 * The verb-first sentence (Anchord-Design `meSentence`, minus the actor `<b>`): `{summary} <tgt>` +
 * an optional ` · {doc}`. The doc is appended ONLY when `target` is not a version label like `v4`
 * (a publish's target IS the version) AND the summary doesn't already name the doc.
 */
function ActionSentence({ row }: { row: MyActivityRow }) {
  const target = row.target;
  const doc = row.docTitle ?? null;
  const appendDoc =
    !!doc && !(target ? /v\d/.test(target) : false) && !(row.summary?.includes(doc) ?? false);
  return (
    <span className="min-w-0 text-[12.5px] leading-[1.5] text-muted">
      {row.summary ? <span>{row.summary} </span> : null}
      {target ? <span className="font-semibold text-accent-ink">{target}</span> : null}
      {appendDoc ? (
        <>
          {" · "}
          <span>{doc}</span>
        </>
      ) : null}
    </span>
  );
}

export function ActionsRow({
  row,
  onOpen,
}: {
  row: MyActivityRow;
  onOpen?: (row: MyActivityRow) => void;
}) {
  const node = actionNodeFor(row.type);
  const meta = (row.meta ?? {}) as ActivityRowMeta;

  return (
    <button
      type="button"
      data-testid={`actions-row-${row.id}`}
      onClick={() => onOpen?.(row)}
      className="grid w-full grid-cols-[8px_34px_1fr] items-start gap-3 border-b border-line py-[13px] pl-[7px] pr-[15px] text-left transition-colors last:border-b-0 hover:bg-elev"
    >
      {/* Unread dot (col 1) — TRANSPARENT for own actions (no unread concept). */}
      <span aria-hidden="true" className="mt-[7px] size-[7px] justify-self-center rounded-full bg-transparent" />

      {/* Toned 34px node (col 2) — no actor avatar on Your actions. */}
      <span className={`grid size-[34px] place-items-center rounded-full ${NODE_TONE_CLASS[node.tone]}`}>
        <Icon name={node.icon} size={16} />
      </span>

      {/* Main column (col 3): sentence + time, quote, preview, chips. */}
      <div className="min-w-0">
        <div className="flex items-baseline gap-[7px]">
          <ActionSentence row={row} />
          <span className="ml-auto flex-none whitespace-nowrap font-mono text-[10.5px] text-subtle">
            {relativeTime(row.createdAt)}
          </span>
        </div>

        {/* Quote (Anchord-Design `.me-quote`): italic, accent left rule, 1-line clamp. */}
        {meta.quote && (
          <div className="mt-1.5 line-clamp-1 border-l-2 border-accent py-px pl-[9px] text-[12px] italic leading-[1.45] text-muted">
            “{meta.quote}”
          </div>
        )}

        {/* Preview (Anchord-Design `.me-preview`): ink, 2-line clamp. */}
        {meta.body && (
          <div className="mt-1.5 line-clamp-2 text-[12.5px] leading-[1.55] text-ink">{meta.body}</div>
        )}

        <ActivityChips event={row} />
      </div>
    </button>
  );
}
