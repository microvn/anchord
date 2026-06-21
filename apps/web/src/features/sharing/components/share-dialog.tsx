import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";
import { useBreakpoint } from "@/hooks/use-breakpoint";
import { toast } from "sonner";
import {
  getShareState,
  changeMemberRole,
  removeMember,
  type ShareState,
  type SharePerson,
  type ShareRole,
} from "@/features/sharing/services/client";
import { AccessSection } from "./access-section";
import { InviteRow } from "./invite-row";
import { PeopleList } from "./people-list";
import { LinkControls } from "./link-controls";
import { CapabilityLinkRow } from "./capability-link-row";
import { OptionsPanel } from "./options-panel";
import { ShareLoadingSkeleton } from "./share-loading-skeleton";
import { TabBar } from "@/components/ui/tabs";
import { useAccessControls } from "@/features/sharing/hooks/use-access-controls";
import { useApiQuery } from "@/lib/api/use-api-query";
import type { EffectiveRole } from "@/features/viewer/services/client";

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

  // AS-018: on OPEN, read the full share state to prefill. Routed through `useApiQuery` (the
  // codebase's single read entry point) instead of a hand-rolled useEffect — so it (a) dedups the
  // request under React StrictMode's double-invoke (no more two `/share` calls per open), (b) peels
  // the api-core envelope CENTRALLY (peelEnvelope), so `state.people` is the payload, not the
  // wrapper, and (c) reuses the normalized ApiError (status carries the 403 for the lazy gate). The
  // read is `enabled` only while open. `staleTime: 0` so EVERY open refetches the current state
  // (the global 30s staleTime would serve a stale snapshot: change a member's role / remove / invite
  // in one open, hit Done, reopen within 30s → the old state. A member mutation updates local state +
  // the server but not this cache, so the dialog must re-read on open to reflect the committed truth).
  const query = useApiQuery<ShareState>(
    ["share-state", workspaceId, slug],
    () => getShareState(workspaceId, slug),
    { enabled: open, staleTime: 0 },
  );
  const state = query.data ?? null;
  const loading = open && query.isPending && query.fetchStatus !== "idle";
  // C-002 lazy gate: a 403 on the gated read means "can't manage" (read-only surface), distinct
  // from a generic load error (network / 500 → the retryable error surface).
  const forbidden = query.isError && query.error?.status === 403;
  const error = query.isError && !forbidden ? "Couldn't load sharing settings" : null;

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
        {/* Fixed-height scroll region: the modal's outer size stays CONSTANT whether the body is the
            loading skeleton or the full sections, so the prefill read swaps content in place instead
            of growing + re-centering the modal (the "two popups" effect on first open). Tall content
            scrolls inside; short content sits within the clamped height. */}
        <div className="-mr-1 h-[58vh] max-h-[600px] min-h-[420px] overflow-y-auto pr-1">{body}</div>
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
    return <ShareLoadingSkeleton />;
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

// The editable scaffolding (shown only to a manager). Two tabs (uselink-style) keep the surface from
// feeling cluttered: "Sharing" (who can read + invite + people) is the primary flow; "Options" holds
// everything secondary (link password/expiry/view-limit, guest commenting, editors-can-share). The
// access state + its PUT …/access live in one shared `useAccessControls` hook so the access level
// (Sharing tab) and guest/editors (Options tab) still write together. S-002..S-006 fill the panels.
const SHARE_TABS = [
  { id: "sharing" as const, label: "Sharing", icon: "share" },
  { id: "options" as const, label: "Options", icon: "settings" },
];

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
  // Shared access state + the optimistic PUT …/access writer (level/role on Sharing; guest/editors
  // on Options). One hook so a level change and a guest toggle never race each other (C-005).
  const controls = useAccessControls(workspaceId, slug, state, effectiveRole);
  const [tab, setTab] = useState<"sharing" | "options">("sharing");

  // People list is owned here (seeded from the prefill read) so InviteRow (S-003) can optimistically
  // append a row + reconcile/rollback it (C-005), and S-006 can optimistically change a role / remove
  // a person + roll back a refused write.
  const [people, setPeople] = useState<SharePerson[]>(state.people);

  // Keep the share-state query cache in sync with the optimistic `people` so REOPENING the dialog
  // shows the committed roster instantly (no stale-then-refetch flash). A member role-change / remove
  // updates this local state + the server, but the cached read still held the old roster — staleTime:0
  // re-reads on reopen, yet for a beat the dialog renders the cached (stale) role before the refetch
  // lands. Writing `people` back to the cache closes that gap: reopen seeds from a correct cache, and
  // the refetch merely confirms it. On a refused write `people` rolls back, re-syncing the cache too.
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.setQueryData<ShareState>(["share-state", workspaceId, slug], (old) =>
      old ? { ...old, people } : old,
    );
  }, [people, queryClient, workspaceId, slug]);

  const addOptimistic = (person: SharePerson) =>
    setPeople((prev) => [...prev.filter((p) => p.email !== person.email), person]);
  const reconcile = (email: string, status: SharePerson["status"], id: string) =>
    setPeople((prev) => prev.map((p) => (p.email === email ? { ...p, status, id } : p)));
  const rollback = (email: string) => setPeople((prev) => prev.filter((p) => p.email !== email));

  // S-006: change a member's role. Optimistically set the new role; on a refused write revert to the
  // prior role + toast (C-005). Targets the doc_members `id` (the PATCH route needs it — S1).
  async function onChangeRole(person: SharePerson, role: ShareRole) {
    if (person.role === role) return;
    if (!person.id) return; // can't target the member without its id (Spec signal S1)
    const prevRole = person.role;
    setPeople((prev) => prev.map((p) => (p.id === person.id ? { ...p, role } : p)));
    const res = await changeMemberRole(workspaceId, slug, person.id, role);
    if (res.error || !res.data) {
      setPeople((prev) => prev.map((p) => (p.id === person.id ? { ...p, role: prevRole } : p)));
      toast.error("Couldn't change that person's role");
    }
  }

  // S-006: remove a person (active member or pending invite). Optimistically drop the row; on a
  // refused write restore it + toast (C-005). Targets the doc_members `id`.
  async function onRemove(person: SharePerson) {
    if (!person.id) return; // can't target the member without its id (Spec signal S1)
    const snapshot = people;
    setPeople((prev) => prev.filter((p) => p.id !== person.id));
    const res = await removeMember(workspaceId, slug, person.id);
    if (res.error || !res.data) {
      setPeople(snapshot);
      toast.error("Couldn't remove that person");
    }
  }

  const inviteeCount = people.filter((p) => p.role !== "owner").length;

  return (
    <div data-testid="share-sections" className="flex flex-col gap-4 pt-1">
      <TabBar tabs={SHARE_TABS} value={tab} onChange={setTab} aria-label="Share settings" />

      {tab === "sharing" ? (
        <div className="flex flex-col gap-4">
          {/* Access definition group — who can read + the role + (when shared by link) the link
              itself. These belong together (the link IS the access choice), so they sit at the
              tighter intra-group gap-3 and read as one unit, set apart from "Invite people" below
              by the container's gap-4. */}
          <div className="flex flex-col gap-3">
            {/* Who can read? — self-describing access rows + role (S-002) */}
            <AccessSection controls={controls} />

            {/* Link + protection — appears inline right under the access choice when the doc is
                shared by link (AS-005: "the Link section appears"). Inline (not behind the Options
                tab) makes copying the link + setting password/expiry/view-limit zero extra clicks
                for the public-share flow, the primary action once Anyone-with-link is on. */}
            {controls.isLink ? (
              <section data-testid="share-sec-link-protection" className="flex flex-col gap-3">
                {/* S-005 (capability-share-link AS-012): the EXTERNAL capability link `/s/<token>` —
                    the unguessable address an anonymous visitor opens. Surfaced ONLY when the read
                    carried a capabilityUrl (anyone_with_link); for restricted / anyone_in_workspace
                    the backend sends null → no capability row (AS-013). It sits ABOVE the in-app
                    address + protection chips, with accent treatment, so the owner copies the right
                    one (distinct from the in-app readable /d/<slug> address below). */}
                {controls.capabilityUrl ? (
                  <CapabilityLinkRow capabilityUrl={controls.capabilityUrl} />
                ) : null}
                {/* Protection chips for the capability link above (password / expiry / view-limit,
                    enforced at /s/:token redeem — S-006). No second copyable URL: the readable
                    /d/<slug> is the in-app address, not an external share link (C-009). */}
                <div className="flex flex-col gap-1.5">
                  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-subtle">· Protection</span>
                  <LinkControls workspaceId={workspaceId} slug={slug} link={state.link} />
                </div>
              </section>
            ) : null}
          </div>

          {/* Invite people / People list (S-003 invite field + optimistic row; S-004/S-006 controls) */}
          <section data-testid="share-sec-people" className="flex flex-col gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-subtle">· Invite people</span>
            <InviteRow
              workspaceId={workspaceId}
              slug={slug}
              onOptimisticAdd={addOptimistic}
              onReconcile={reconcile}
              onRollback={rollback}
            />
            <div className="flex items-baseline justify-between border-t border-line pt-3">
              <span className="text-[12px] font-medium text-muted">People with access</span>
              <span data-testid="share-people-count" className="font-mono text-[11px] text-subtle">
                {inviteeCount} {inviteeCount === 1 ? "invitee" : "invitees"}
              </span>
            </div>
            <PeopleList people={people} onChangeRole={onChangeRole} onRemove={onRemove} />
          </section>
        </div>
      ) : (
        <OptionsPanel controls={controls} />
      )}
    </div>
  );
}
