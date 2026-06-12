import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { useBreakpoint } from "../../lib/use-breakpoint";
import { canManageShare, getShareState, type ShareState, type SharePerson } from "./client";
import { AccessSection } from "./access-section";
import { InviteRow } from "./invite-row";
import { PeopleList } from "./people-list";
import type { EffectiveRole } from "../viewer/client";

// ShareDialog (sharing-permissions-ui S-001) — the SHELL. It opens from the viewer Share button
// (and the docs-list ⋯ menu), gates on whether the session can manage sharing (C-002), is a
// centered modal ≥601px and a full-screen sheet ≤600 (AS-002), and on open PREFILLS the current
// sharing state from GET …/share (AS-018). It renders the section scaffolding (General access ·
// Guest commenting · Link (when anyone-with-link) · Invite people / People list) showing the
// CURRENT state read-only-ish — the editable controls (segmented access / role / invite / link
// chips) are filled in by S-002..S-005. 1:1 structure with the prototype `ShareDialog` (P16,
// Anchord-Design/viewer-dialogs.jsx): "Share doc" title, doc-title subtext, a "Done" footer.
//
// C-002 (manage gate): the EDITABLE dialog shows only when canManageShare — owner always; editor
// only when `editorsCanShare` is on (from the prefill read); viewer/commenter never; an ABSENT
// effectiveRole ⇒ NOT manage (conservative). `effectiveRole` alone decides whether the Share button
// is shown in the top bar (owner/editor); `editorsCanShare` is only knowable once the dialog reads
// the share state, so an editor whose toggle is OFF opens the dialog but is shown the
// not-allowed surface, never the management controls.

export function ShareDialog({
  open,
  onOpenChange,
  workspaceId,
  slug,
  docTitle,
  effectiveRole,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  slug: string;
  docTitle: string;
  /** the session's effective role on this doc — gates manage-eligibility (C-002). */
  effectiveRole: EffectiveRole | undefined;
}) {
  const tier = useBreakpoint();
  // AS-002: ≤600 (the `mobile` tier, <600 in DESIGN.md §Responsive) renders a full-screen sheet;
  // ≥601 (tablet+) is a centered modal. The branch is testable via the breakpoint hook; pixel
  // layout is [→MANUAL].
  const compact = tier === "mobile";

  const [state, setState] = useState<ShareState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AS-018: on OPEN, read the full share state to prefill. Reset on close so a re-open re-reads.
  useEffect(() => {
    if (!open) {
      setState(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getShareState(workspaceId, slug)
      .then((res) => {
        if (cancelled) return;
        if (res.error || !res.data) {
          setError("Couldn't load sharing settings");
          return;
        }
        setState(res.data);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load sharing settings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, slug]);

  const body = (
    <ShareDialogBody
      state={state}
      loading={loading}
      error={error}
      effectiveRole={effectiveRole}
      workspaceId={workspaceId}
      slug={slug}
    />
  );

  if (compact) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          data-testid="share-dialog"
          data-variant="sheet"
          className="inset-0 h-dvh w-full max-w-none border-line bg-surface"
        >
          <SheetHeader>
            <SheetTitle className="font-serif text-[21px] font-medium text-ink">
              Share doc
            </SheetTitle>
            <SheetDescription className="text-[13px] text-muted">{docTitle}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-auto px-4">{body}</div>
          <SheetFooter>
            <Button
              type="button"
              data-testid="share-done"
              onClick={() => onOpenChange(false)}
            >
              Done
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="share-dialog"
        data-variant="modal"
        overlayClassName="bg-[var(--scrim)]"
        className="border-line bg-surface sm:max-w-[540px]"
      >
        <DialogHeader>
          <DialogTitle className="font-serif text-[21px] font-medium text-ink">
            Share doc
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted">{docTitle}</DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button type="button" data-testid="share-done" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareDialogBody({
  state,
  loading,
  error,
  effectiveRole,
  workspaceId,
  slug,
}: {
  state: ShareState | null;
  loading: boolean;
  error: string | null;
  effectiveRole: EffectiveRole | undefined;
  workspaceId: string;
  slug: string;
}) {
  if (loading || (!state && !error)) {
    return (
      <div data-testid="share-loading" className="py-6 text-[13px] text-muted">
        Loading sharing settings…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        data-testid="share-error"
        className="flex items-center gap-2 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-[12.5px] text-error"
      >
        <Icon name="alert" size={14} />
        {error}
      </div>
    );
  }

  if (!state) return null;

  // C-002: with the prefill read in hand, decide manage-eligibility (editor case needs
  // editorsCanShare from the read). A non-manager is NEVER shown the editable controls — they see
  // a read-only "you can't manage sharing" surface instead.
  if (!canManageShare(effectiveRole, state.editorsCanShare)) {
    return (
      <div data-testid="share-readonly" className="py-6 text-[13px] text-muted">
        You don&apos;t have permission to manage sharing for this doc.
      </div>
    );
  }

  return (
    <ShareSections
      state={state}
      workspaceId={workspaceId}
      slug={slug}
      effectiveRole={effectiveRole}
    />
  );
}

// The editable section scaffolding (shown only to a manager). S-001 built the SHELL; S-002 mounts
// the editable General-access controls (AccessSection); S-003..S-005 fill in invite / people / link.
function ShareSections({
  state,
  workspaceId,
  slug,
  effectiveRole,
}: {
  state: ShareState;
  workspaceId: string;
  slug: string;
  effectiveRole: EffectiveRole | undefined;
}) {
  // The selected level is owned here so it can be optimistically updated by AccessSection and drive
  // the Link section's visibility (C-007) without a re-read. Seeded from the prefill state.
  const [level, setLevel] = useState<ShareState["level"]>(state.level);
  const isLink = level === "anyone_with_link";

  // People list is owned here (seeded from the prefill read) so InviteRow (S-003) can optimistically
  // append a row + reconcile/rollback it (C-005); S-004 formalizes the per-row controls.
  const [people, setPeople] = useState<SharePerson[]>(state.people);
  const addOptimistic = (person: SharePerson) =>
    setPeople((prev) => [...prev.filter((p) => p.email !== person.email), person]);
  const reconcile = (email: string, status: SharePerson["status"]) =>
    setPeople((prev) => prev.map((p) => (p.email === email ? { ...p, status } : p)));
  const rollback = (email: string) => setPeople((prev) => prev.filter((p) => p.email !== email));

  return (
    <div data-testid="share-sections" className="flex flex-col gap-4 pt-1">
      {/* General access + guest + editors_can_share (S-002, AccessSection) */}
      <AccessSection
        workspaceId={workspaceId}
        slug={slug}
        initial={state}
        effectiveRole={effectiveRole}
        onLevelChange={setLevel}
      />

      {/* Link — shown only when anyone-with-link (C-007). S-005 fills Copy + the chips. */}
      {isLink && (
        <section data-testid="share-sec-link" className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-muted">Link</span>
          <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
            <Icon name="link" size={14} />
            <code data-testid="share-link-url" className="min-w-0 flex-1 truncate text-[12px] text-ink">
              {state.link.url}
            </code>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span
              data-testid="share-link-password"
              data-on={state.link.hasPassword ? "1" : "0"}
              className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle"
            >
              <Icon name="shield" size={12} />
              {state.link.hasPassword ? "Password · set" : "+ Password"}
            </span>
            <span
              data-testid="share-link-expiry"
              data-on={state.link.expiresAt ? "1" : "0"}
              className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle"
            >
              <Icon name="clock" size={12} />
              {state.link.expiresAt ? "Expiry · set" : "+ Expiry"}
            </span>
            <span
              data-testid="share-link-limit"
              data-on={state.link.viewLimit ? "1" : "0"}
              className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle"
            >
              <Icon name="user" size={12} />
              {state.link.viewLimit ? "View limit · set" : "+ View limit"}
            </span>
          </div>
        </section>
      )}

      {/* Invite people / People list (S-003 invite field + optimistic row; S-004 the row controls) */}
      <section data-testid="share-sec-people" className="flex flex-col gap-2">
        <span className="text-[12px] font-medium text-muted">Invite people</span>
        <InviteRow
          workspaceId={workspaceId}
          slug={slug}
          onOptimisticAdd={addOptimistic}
          onReconcile={reconcile}
          onRollback={rollback}
        />
        <PeopleList people={people} />
      </section>
    </div>
  );
}
