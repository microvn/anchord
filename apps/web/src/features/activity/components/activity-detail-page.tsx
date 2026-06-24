import { format, formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";
import { Icon } from "@/components/icon";
import { ActivityRow } from "@/features/activity/components/activity-row";
import { PublishDiffMini, versionLabel } from "@/features/activity/components/publish-diff-mini";
import { openDocHref } from "@/features/activity/lib/open-doc-href";
import type {
  ActivityRowMeta,
  ActivityEventDetail,
  ActivityEventRow,
  ActivityPublishMeta,
  ActivityType,
} from "@/features/activity/types";

// ActivityDetailPage (workspace-activity S-004 — route /w/:id/activity/:eventId).
//
// PRESENTATIONAL / rows-as-props (export contract / ## Linked Fields): takes the event + its related
// rows, NOT bound to any fetch — the wrapper does the reads and passes them down so the personal
// "Your actions" detail (2b) can reuse it. Mirrors the prototype `ActivityDetail` (activity.jsx):
//   - back link to the feed
//   - hero: type node-icon + the event sentence + a type badge + when
//   - body card: optional quote + PublishDiffMini (publish only, AS-015) + metadata key-value list
//   - rail: "More on this doc" related events + document card + "Open doc" deep-link
//
// All actor/summary/target/project text is PLAIN TEXT — React escapes it; never
// dangerouslySetInnerHTML (F-12 / guest-name defence-in-depth). AS-018: a deleted-doc event still
// renders from its stored fields here, and "Open doc" degrades (openDocHref → null → disabled).

const TYPE_META: Record<ActivityType, { icon: string; tone: string; label: string }> = {
  comment: { icon: "inbox", tone: "text-accent", label: "Comment" },
  reply: { icon: "inbox", tone: "text-muted", label: "Reply" },
  resolve: { icon: "check", tone: "text-success", label: "Resolved" },
  publish: { icon: "arrowRight", tone: "text-accent", label: "Publish" },
  restore: { icon: "refresh", tone: "text-amber", label: "Restore" },
  share: { icon: "share", tone: "text-accent", label: "Sharing" },
  invite: { icon: "mail", tone: "text-muted", label: "Invite" },
  member: { icon: "members", tone: "text-success", label: "Member" },
  member_removed: { icon: "members", tone: "text-amber", label: "Member removed" },
  workspace_renamed: { icon: "pencil", tone: "text-muted", label: "Workspace renamed" },
  project: { icon: "folder", tone: "text-muted", label: "Project" },
  detached: { icon: "alert", tone: "text-amber", label: "Detached" },
};

function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${format(d, "MMM d, yyyy 'at' h:mm a")} · ${formatDistanceToNow(d, { addSuffix: true })}`;
}

/** The hero sentence "<actor> <summary> <target> in <doc>" — all plain text (escaped). Emphasis
 *  mirrors the feed row: muted base, actor ink-semibold, target + doc accent-ink-semibold. */
function Sentence({ event }: { event: ActivityEventDetail }) {
  const showInDoc =
    event.docTitle &&
    event.docTitle !== event.target &&
    event.type !== "publish" &&
    event.type !== "restore";
  return (
    <span className="text-[15px] leading-snug text-muted">
      <b className="font-semibold text-ink">{event.actorName}</b>
      {event.summary ? ` ${event.summary} ` : " "}
      {event.target ? <span className="font-semibold text-accent-ink">{event.target}</span> : null}
      {showInDoc ? (
        <>
          {" in "}
          <span className="font-semibold text-accent-ink">{event.docTitle}</span>
        </>
      ) : null}
    </span>
  );
}

export function ActivityDetailPage({
  event,
  related,
  backHref,
}: {
  event: ActivityEventDetail;
  related: ActivityEventRow[];
  /** the feed route to return to (e.g. /w/:id/activity). */
  backHref: string;
}) {
  const meta = TYPE_META[event.type] ?? TYPE_META.comment;
  const href = openDocHref(event);
  const publishMeta = (event.meta ?? {}) as ActivityPublishMeta;
  const detailMeta = (event.meta ?? {}) as ActivityRowMeta;

  // Metadata key-value rows (AS-014: actor, document, project, version, when).
  const kv: { k: string; v: string }[] = [];
  kv.push({ k: "Actor", v: event.actorName });
  // Prefer the read-enriched doc title; fall back to target (legacy rows where target = doc title).
  const docName = event.docTitle ?? (event.type !== "publish" && event.type !== "restore" ? event.target : null);
  if (docName) kv.push({ k: "Document", v: docName });
  if (event.projectName) kv.push({ k: "Project", v: event.projectName });
  if (event.type === "publish" && publishMeta.to != null)
    kv.push({ k: "Version", v: versionLabel(publishMeta.to) });
  kv.push({ k: "When", v: whenText(event.createdAt) });

  return (
    <section className="mx-auto max-w-[1100px] px-6 py-8" data-testid="activity-detail">
      <Link
        to={backHref}
        data-testid="detail-back"
        className="mb-5 inline-flex items-center gap-1.5 text-[12.5px] text-subtle hover:text-ink"
      >
        <Icon name="chevLeft" size={15} />
        Back to activity
      </Link>

      {/* hero */}
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex-none ${meta.tone}`}>
          <Icon name={meta.icon} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <Sentence event={event} />
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px] text-subtle">
            <span className="inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 font-mono uppercase tracking-[0.08em]">
              {meta.label}
            </span>
            <span className="h-1 w-1 rounded-full bg-line" />
            <span>{whenText(event.createdAt)}</span>
          </div>
        </div>
        {/* "Open doc" deep-link. AS-016 resolves to the annotation; AS-017 to the top; AS-018 (no
            live slug) DEGRADES to a disabled control rather than a broken link. */}
        <OpenDocButton href={href} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* body card: the annotated quote (if any) + the event body, then the publish diff. Mirrors
            the prototype .detail-body-card (.quote-ref + .body-text + .diff-mini). */}
        <div className="rounded-[11px] border border-line bg-surface p-5">
          {detailMeta.quote ? (
            <div className="mb-3 border-l-2 border-accent pl-3 text-[13px] italic leading-relaxed text-muted">
              “{detailMeta.quote}”
            </div>
          ) : null}
          {detailMeta.body ? (
            <p className="text-[14.5px] leading-relaxed text-ink">{detailMeta.body}</p>
          ) : (
            <p className="text-[13.5px] leading-relaxed text-muted">
              <b className="font-semibold text-ink">{event.actorName}</b> {event.summary}
              {event.target ? <span className="font-semibold text-accent-ink"> {event.target}</span> : null}.
            </p>
          )}
          {event.type === "publish" && <PublishDiffMini slug={event.docSlug} meta={publishMeta} />}
          <dl className="mt-4 grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 border-t border-line pt-4">
            {kv.map((row) => (
              <div key={row.k} className="contents">
                <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-subtle">{row.k}</dt>
                <dd className="text-[13px] text-ink">{row.v}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* rail */}
        <div className="flex flex-col gap-4">
          {related.length > 0 && (
            <div data-testid="detail-related" className="rounded-[11px] border border-line bg-surface p-4">
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-subtle">
                More on this doc
              </div>
              <div className="flex flex-col gap-2">
                {related.map((r) => (
                  <ActivityRow key={r.id} event={r} />
                ))}
              </div>
            </div>
          )}
          {docName && (
            <div className="rounded-[11px] border border-line bg-surface p-4">
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.1em] text-subtle">Document</div>
              <div className="text-[13.5px] font-semibold leading-snug text-ink">{docName}</div>
              {(event.projectName || (event.type === "publish" && publishMeta.to != null)) && (
                <div className="mt-1 font-mono text-[11.5px] text-subtle">
                  {event.projectName}
                  {event.type === "publish" && publishMeta.to != null ? ` · ${versionLabel(publishMeta.to)}` : ""}
                </div>
              )}
              <div className="mt-3">
                <OpenDocButton href={href} block />
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** "Open doc" control — a real link when an href resolves, a disabled span when it degraded (AS-018). */
function OpenDocButton({ href, block = false }: { href: string | null; block?: boolean }) {
  const base = `inline-flex items-center justify-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-[12.5px] font-medium ${
    block ? "w-full" : ""
  }`;
  if (!href) {
    return (
      <span
        data-testid="open-doc"
        data-degraded="1"
        aria-disabled="true"
        title="This document is no longer available"
        className={`${base} flex-none cursor-not-allowed border-line text-subtle opacity-60`}
      >
        <Icon name="arrowRight" size={14} />
        Open doc
      </span>
    );
  }
  return (
    <a
      data-testid="open-doc"
      href={href}
      className={`${base} flex-none border-line text-ink hover:border-accent/50 hover:text-accent`}
    >
      <Icon name="arrowRight" size={14} />
      Open doc
    </a>
  );
}
