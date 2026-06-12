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
import { getShareState, isForbidden, type ShareState, type SharePerson } from "./client";
import { AccessSection } from "./access-section";
import { InviteRow } from "./invite-row";
import { PeopleList } from "./people-list";
import { LinkControls } from "./link-controls";
import type { EffectiveRole } from "../viewer/client";

// ShareDialog (sharing-permissions-ui S-001) — the SHELL. It opens from the viewer Share button
// (and the docs-list ⋯ menu), gates LAZILY on the gated `GET …/share` read result (C-002), is a
// centered modal ≥601px and a full-screen sheet ≤600 (AS-002), and on open PREFILLS the current
// sharing state from GET …/share (AS-018). It renders the section scaffolding (General access ·
// Guest commenting · Link (when anyone-with-link) · Invite people / People list) showing the
// CURRENT state read-only-ish — the editable controls (segmented access / role / invite / link
// chips) are filled in by S-002..S-005. 1:1 structure with the prototype `ShareDialog` (P16,
// Anchord-Design/viewer-dialogs.jsx): "Share doc" title, doc-title subtext, a "Done" footer.
//
// C-002 (manage gate, LAZY — reworked 2026-06-13): manage-eligibility is the RESULT of the gated
// `GET …/share` read, not a pre-computed `effectiveRole`. A read that SUCCEEDS proves the caller can
// manage (the backend gated it identically to the writes, backend C-016) → editable sections. A read
// REFUSED with 403 → the read-only "you can't manage sharing" surface. Any OTHER failure (network /
// 500) → the generic retryable error surface. `effectiveRole` stays a prop ONLY so the viewer top bar
// can hide the Share button for a viewer/commenter as a pre-read hint (that wiring lives in
// viewer-top-bar/viewer-screen); the dialog itself no longer gates on it.

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
  // C-002 lazy gate: a 403 on the gated read means "can't manage" (read-only surface), distinct
  // from a generic load error.
  const [forbidden, setForbidden] = useState(false);

  // AS-018: on OPEN, read the full share state to prefill. Reset on close so a re-open re-reads.
  useEffect(() => {
    if (!open) {
      setState(null);
      setError(null);
      setForbidden(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setForbidden(false);
    void getShareState(workspaceId, slug)
      .then((res) => {
        if (cancelled) return;
        if (res.error || !res.data) {
          // A refused (403) gated read → the read-only "can't manage" surface (AS-003); any other
          // failure → the generic retryable error (AS network/500).
          if (isForbidden(res.error)) setForbidden(true);
          else setError("Couldn't load sharing settings");
          return;
        }
        // A successful read PROVES manage-eligibility (AS-004) — render the editable sections.
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
      forbidden={forbidden}
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
  forbidden,
  effectiveRole,
  workspaceId,
  slug,
}: {
  state: ShareState | null;
  loading: boolean;
  error: string | null;
  forbidden: boolean;
  effectiveRole: EffectiveRole | undefined;
  workspaceId: string;
  slug: string;
}) {
  if (loading || (!state && !error && !forbidden)) {
    return (
      <div data-testid="share-loading" className="py-6 text-[13px] text-muted">
        Loading sharing settings…
      </div>
    );
  }

  // C-002 (lazy gate): a REFUSED (403) gated read → the read-only "can't manage" surface, distinct
  // from a generic load error. The read itself is the manage-eligibility decision.
  if (forbidden) {
    return (
      <div data-testid="share-readonly" className="py-6 text-[13px] text-muted">
        You don&apos;t have permission to manage sharing for this doc.
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

  // A successful read proved manage-eligibility (C-002 / AS-004) — render the editable sections.
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

      {/* Link — shown only when anyone-with-link (C-007). Copy + the independent chips (S-005). */}
      {isLink && <LinkControls workspaceId={workspaceId} slug={slug} link={state.link} />}

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
