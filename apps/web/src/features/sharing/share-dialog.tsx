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
import { initials, avatarColor } from "../../lib/initials";
import { useBreakpoint } from "../../lib/use-breakpoint";
import { canManageShare, getShareState, type ShareState } from "./client";
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

const ACCESS_LABEL: Record<ShareState["level"], string> = {
  restricted: "Restricted",
  anyone_in_workspace: "Anyone in workspace",
  anyone_with_link: "Anyone with link",
};

const ACCESS_HINT: Record<ShareState["level"], string> = {
  restricted: "Only people invited below can open this doc.",
  anyone_in_workspace: "Everyone in this workspace can open this doc.",
  anyone_with_link: "Anyone with the link can open this doc — no sign-in needed.",
};

const ACCESS_ICON: Record<ShareState["level"], "shield" | "members" | "link"> = {
  restricted: "shield",
  anyone_in_workspace: "members",
  anyone_with_link: "link",
};

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

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
}: {
  state: ShareState | null;
  loading: boolean;
  error: string | null;
  effectiveRole: EffectiveRole | undefined;
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

  return <ShareSections state={state} />;
}

// The editable section scaffolding (shown only to a manager). S-001 builds the SHELL + shows the
// CURRENT prefilled values; S-002..S-005 fill in the interactive controls.
function ShareSections({ state }: { state: ShareState }) {
  const isLink = state.level === "anyone_with_link";

  return (
    <div data-testid="share-sections" className="flex flex-col gap-4 pt-1">
      {/* General access (S-002 fills the segmented control + role select) */}
      <section data-testid="share-sec-access" className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-muted">General access</span>
        <div className="flex items-center gap-2">
          <span
            data-testid="share-access-level"
            className="rounded-md border border-line bg-sunken px-2.5 py-1 text-[12.5px] font-semibold text-ink"
          >
            {ACCESS_LABEL[state.level]}
          </span>
          <span
            data-testid="share-access-role"
            className="rounded-md border border-line bg-sunken px-2.5 py-1 text-[12.5px] text-ink"
          >
            {roleLabel(state.role)}
          </span>
        </div>
        <p className="flex items-center gap-1.5 text-[11.5px] text-subtle">
          <Icon name={ACCESS_ICON[state.level]} size={13} />
          {ACCESS_HINT[state.level]}
        </p>
      </section>

      {/* Guest commenting (S-002 makes it editable; enabled only for anyone-with-link, C-001) */}
      <section data-testid="share-sec-guest" className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-ink">Allow guest commenting</div>
          <div className="text-[11.5px] text-subtle">
            {isLink
              ? "Link visitors can comment without an account."
              : "Available only for Anyone with link."}
          </div>
        </div>
        <span
          data-testid="share-guest-state"
          aria-disabled={!isLink}
          data-on={state.guestCommenting ? "1" : "0"}
          className="rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-muted"
        >
          {state.guestCommenting ? "On" : "Off"}
        </span>
      </section>

      {/* editors_can_share — owner-editable only (S-002, C-003). Shown here read-only as prefill. */}
      <section
        data-testid="share-sec-editors-can-share"
        className="flex items-center justify-between gap-3"
      >
        <div className="text-[13px] font-medium text-ink">Editors can change sharing</div>
        <span
          data-testid="share-editors-can-share-state"
          data-on={state.editorsCanShare ? "1" : "0"}
          className="rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-muted"
        >
          {state.editorsCanShare ? "On" : "Off"}
        </span>
      </section>

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

      {/* Invite people / People list (S-003 fills the invite field; S-004 the row controls) */}
      <section data-testid="share-sec-people" className="flex flex-col gap-2">
        <span className="text-[12px] font-medium text-muted">Invite people</span>
        <div
          data-testid="share-invite-row"
          className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-2 text-[12.5px] text-subtle"
        >
          <Icon name="mail" size={15} />
          Invite by email address…
        </div>
        <div data-testid="share-people-list" className="flex flex-col gap-1.5">
          {state.people.map((p) => {
            const name = p.name ?? p.email;
            return (
              <div
                key={p.userId ?? p.email}
                data-testid={`share-person-${p.email}`}
                className="flex items-center gap-2.5"
              >
                <span
                  aria-hidden="true"
                  className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full font-mono text-[10.5px] font-semibold text-white"
                  style={{ background: avatarColor(name) }}
                >
                  {initials(name)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate text-[13px] font-medium text-ink">
                    {name}
                    {p.status === "pending" && (
                      <span
                        data-testid={`share-person-pending-${p.email}`}
                        className="inline-flex h-[18px] items-center gap-[5px] rounded-[6px] bg-amber-bg px-[6px] font-mono text-[10.5px] font-medium tracking-[0.04em] text-amber"
                      >
                        <Icon name="clock" size={10} />
                        Pending
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11.5px] text-subtle">{p.email}</div>
                </div>
                <span className="flex-none text-[12px] text-muted">{roleLabel(p.role)}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
