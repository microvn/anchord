import { format, formatDistanceToNow } from "date-fns";
import { Icon } from "@/components/icon";
import { initials } from "@/lib/initials";
import { ActivityChips } from "@/features/activity/components/activity-chips";
import { openDocHref } from "@/features/activity/lib/open-doc-href";
import { actionNodeFor, NODE_TONE_CLASS } from "@/features/your-activity/lib/node-style";
import type { ActivityRowMeta, ActivityType } from "@/features/activity/types";
import type { MyActivityRow } from "@/features/your-activity/types";

// your-activity-actions S-001 — a "Your actions" row's DETAIL in the PERSONAL family (Anchord-Design
// `PersonalDetail` / `.me-detail`), NOT the workspace `ActivityDetailPage`. Per C-007 (reversed): a
// Back control, a hero (toned node + verb-first sentence + a type badge + absolute time), a
// `.me-detail-kv` grid (Workspace / Document / Project / When), the body, the chips, and an "Open in
// doc" link built from `row.docSlug` — shown ONLY when a slug is present (the backend genericizes /
// nulls it on lost access — AS-005/AS-006/C-002, so a lost-access row shows no link, never a broken
// one). All text is PLAIN (React-escaped); never dangerouslySetInnerHTML.

const TYPE_LABEL: Record<ActivityType, string> = {
  comment: "Comment",
  reply: "Reply",
  resolve: "Resolved",
  publish: "Published",
  restore: "Restore",
  share: "Share",
  invite: "Invite",
  member: "Member",
  member_removed: "Member removed",
  workspace_renamed: "Workspace renamed",
  project: "Project",
  detached: "Detached",
};

function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${format(d, "MMM d, yyyy 'at' h:mm a")} · ${formatDistanceToNow(d, { addSuffix: true })}`;
}

export function ActionsDetail({
  row,
  onBack,
}: {
  row: MyActivityRow;
  onBack?: () => void;
}) {
  const node = actionNodeFor(row.type);
  const tone = node.tone;
  const meta = (row.meta ?? {}) as ActivityRowMeta;
  const doc = row.docTitle ?? null;
  const href = openDocHref(row);

  // The doc is appended to the sentence only when target isn't a version label and the summary
  // doesn't already name it (same rule as the row's `meSentence`).
  const appendDoc =
    !!doc && !(row.target ? /v\d/.test(row.target) : false) && !(row.summary?.includes(doc) ?? false);

  // .me-detail-kv (Workspace / Document / Project / When) — each row renders only when present.
  const kv: Array<{ label: string; node: React.ReactNode; value: string }> = [];
  if (row.workspaceName) {
    kv.push({
      label: "Workspace",
      node: (
        <span className="grid size-4 flex-none place-items-center rounded-[4px] bg-accent-soft text-[8px] font-semibold uppercase leading-none text-accent-ink">
          {initials(row.workspaceName)}
        </span>
      ),
      value: row.workspaceName,
    });
  }
  if (doc) {
    kv.push({ label: "Document", node: <Icon name="docs" size={13} />, value: doc });
  }
  if (row.projectName) {
    kv.push({ label: "Project", node: <Icon name="folder" size={13} />, value: row.projectName });
  }
  kv.push({ label: "When", node: <Icon name="clock" size={13} />, value: whenText(row.createdAt) });

  return (
    <div data-testid="actions-detail" className="mx-auto max-w-[720px]">
      <button
        type="button"
        data-testid="actions-detail-back"
        onClick={onBack}
        className="mb-[18px] inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted transition-colors hover:text-ink"
      >
        <Icon name="chevLeft" size={15} />
        Back
      </button>

      {/* Hero: toned node + verb-first sentence + type badge + absolute time. */}
      <div className="mb-[18px] flex items-start gap-3.5">
        <span
          className={`grid size-[42px] flex-none place-items-center rounded-full ${NODE_TONE_CLASS[tone]}`}
        >
          <Icon name={node.icon} size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[20px] font-medium leading-[1.25] tracking-[-0.01em] text-ink">
            {row.summary ? <span>{row.summary} </span> : null}
            {row.target ? <span className="text-accent-ink">{row.target}</span> : null}
            {appendDoc ? (
              <>
                {" · "}
                <span>{doc}</span>
              </>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-[9px] text-[12.5px] text-muted">
            <span
              className={
                "inline-flex h-[19px] items-center rounded-md px-[7px] font-mono text-[11px] font-medium tracking-[0.04em] " +
                (tone === "accent"
                  ? "bg-accent-soft text-accent-ink"
                  : tone === "amber"
                    ? "bg-amber-bg text-amber"
                    : tone === "green"
                      ? "bg-success/15 text-success"
                      : "border border-line bg-elev text-muted")
              }
            >
              {TYPE_LABEL[row.type] ?? "Activity"}
            </span>
            <span className="size-[3px] rounded-full bg-faint" />
            <span>{whenText(row.createdAt)}</span>
          </div>
        </div>
      </div>

      {/* Card: quote + body + the key/value grid + chips + "Open in doc". */}
      <div className="rounded-lg border border-line bg-surface px-5 py-[18px]">
        {meta.quote && (
          <div
            data-testid="actions-detail-quote"
            className="mb-3 border-l-2 border-accent py-[3px] pl-3 text-[13px] italic leading-relaxed text-muted"
          >
            “{meta.quote}”
          </div>
        )}
        {meta.body && (
          <div className="text-[14.5px] leading-[1.7] text-ink">{meta.body}</div>
        )}

        <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 border-t border-line pt-3.5">
          {kv.map((item) => (
            <div key={item.label} className="contents">
              <span className="self-center font-mono text-[10.5px] uppercase tracking-[0.05em] text-subtle">
                {item.label}
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink">
                {item.node}
                {item.value}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4">
          <ActivityChips event={row} />
        </div>

        {/* "Open in doc" — built from row.docSlug. Shown ONLY when a slug is present (null on a
            workspace-level row or lost access — C-002 / AS-006). */}
        {href && (
          <div className="mt-4 border-t border-line pt-4">
            <a
              data-testid="actions-open-doc"
              href={href}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-elev px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-accent-soft hover:text-accent-ink"
            >
              <Icon name="arrowRight" size={14} />
              Open in doc
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
