import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShareDialog } from "@/features/sharing/components/share-dialog";
import { DeleteDocDialog } from "./delete-doc-dialog";
import { VisibilityBoundaryAlert } from "./visibility-boundary-alert";
import { ProjectVisibilityBadge } from "./project-visibility-badge";
import type { EffectiveRole } from "@/features/viewer/services/client";
import { useDocMove } from "@/features/docs/hooks/use-doc-move";
import type { DocRow, ProjectRow } from "@/features/docs/types";

// MoveCopyDialog (workspace-project-ui S-001) — 1:1 with Anchord-Design dialogs2.jsx P10.
// A Move|Copy toggle (fmt-toggle), a destination project select-list (folder glyph · name ·
// Default badge · check on the selected), and a helper line. The destination list is the
// active workspace's projects ONLY (C-003) — the caller passes the workspace-scoped list.
// Move → POST …/docs/:slug/move; Copy → POST …/docs/:slug/copy (a clean duplicate, original
// stays). The mutation logic (incl. the project-visibility-fe S-003 boundary alert flow) lives in
// useDocMove; this component is the presentation + destination-picker shell.

type Mode = "move" | "copy";

export function MoveCopyDialog({
  open,
  onOpenChange,
  doc,
  workspaceId,
  projects,
  initialMode = "move",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: DocRow;
  workspaceId: string;
  projects: ProjectRow[];
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  // Pre-select a project that isn't the doc's current one (matches the prototype).
  const firstOther = projects.find((p) => p.id !== doc.projectId);
  const [target, setTarget] = useState<string>(firstOther?.id ?? projects[0]?.id ?? "");
  // The mutation + visibility-boundary flow (project-visibility-fe S-003) lives in the hook; this
  // shell only owns the picker selection + mode. `onDone` closes the dialog on a completed op.
  const { busy, error, boundaryTarget, boundaryTargetName, confirm, chooseBoundary, cancelBoundary } =
    useDocMove(workspaceId, doc, projects, () => onOpenChange(false));

  function onConfirm() {
    if (!target) return;
    void confirm(mode, target);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="move-copy-dialog"
        overlayClassName="bg-[var(--scrim)]"
        className="border-line bg-surface sm:max-w-[460px]"
      >
        <DialogHeader>
          <DialogTitle className="font-serif text-[21px] font-medium text-ink">
            {mode === "move" ? "Move" : "Copy"} doc
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted">{doc.title}</DialogDescription>
        </DialogHeader>

        {/* Move|Copy toggle — Anchord-Design `.fmt-toggle`: a compact, content-width pill
            (inline-flex; 28px-tall buttons, 14px side padding), NOT stretched full-width. */}
        <div className="inline-flex w-fit gap-0.5 justify-self-start rounded-md border border-line bg-sunken p-0.5">
          {(["move", "copy"] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`mode-${m}`}
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`h-7 rounded-sm px-3.5 text-[12.5px] capitalize transition-colors ${
                mode === m
                  ? "bg-surface font-semibold text-accent-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                  : "font-medium text-muted hover:text-ink"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-muted">
            Destination project
          </span>
          <div className="flex flex-col gap-1" role="listbox" aria-label="Destination project">
            {projects.map((p) => {
              const selected = target === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`dest-project-${p.id}`}
                  role="option"
                  aria-selected={selected}
                  onClick={() => setTarget(p.id)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                    selected
                      ? "border-accent bg-accent-soft"
                      : "border-line bg-surface hover:border-subtle"
                  }`}
                >
                  <span className="grid size-[26px] flex-none place-items-center rounded-md bg-sunken text-subtle">
                    <Icon name="folder" size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                    {p.name}
                  </span>
                  {/* project-visibility-fe S-002 / AS-007: per-option Private/Public badge, read from
                      the row's server `visibility` (C-001). Absent on a legacy row → no badge. */}
                  {p.visibility && <ProjectVisibilityBadge visibility={p.visibility} />}
                  {p.isDefault && (
                    <span className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-[0.06em] text-subtle">
                      Default
                    </span>
                  )}
                  {selected && (
                    <span className="text-accent">
                      <Icon name="check" size={15} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-[9px] text-[11.5px] text-subtle">
            {mode === "move"
              ? "The doc leaves its current project."
              : "A duplicate is created; the original stays put."}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            data-testid="move-copy-error"
            className="flex items-center gap-2 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-[12.5px] text-error"
          >
            <Icon name="alert" size={14} />
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="move-copy-confirm"
            disabled={!target || busy}
            onClick={onConfirm}
          >
            <Icon name={mode === "move" ? "arrowRight" : "copy"} size={15} />
            {busy ? "Working…" : mode === "move" ? "Move" : "Copy"}
          </Button>
        </div>
      </DialogContent>
      </Dialog>

      {/* project-visibility-fe S-003 / C-002: opened ONLY on the server's `visibility_boundary`
          refusal. Rendered as a sibling of the move Dialog (both portal to <body>) so the choice
          survives independently and the alert never auto-closes the move flow. */}
      <VisibilityBoundaryAlert
        open={boundaryTarget !== null}
        docTitle={doc.title}
        targetName={boundaryTargetName}
        busy={busy}
        onMakePrivate={() => void chooseBoundary("make_private")}
        onKeepSharing={() => void chooseBoundary("keep_sharing")}
        onCancel={cancelBoundary}
      />
    </>
  );
}

// The ⋯ button on a DocCard / DocList row. sharing-permissions-ui S-001 (AS-019) refactored this
// from a DIRECT MoveCopyDialog open into a ⋯ DROPDOWN offering Share · Move · Copy (mirroring
// `ProjectCardMoreMenu`): Share opens the ShareDialog, Move/Copy open the MoveCopyDialog at the
// matching mode. Self-contained so the grid card and the list row reuse it identically.
//
// The wrapper's onClick stops propagation: the kebab + the Radix menu/dialogs render inside the
// surrounding doc-card <Link>, and Radix portals to <body> but React still bubbles portal events
// UP THE REACT TREE — so a click inside (menu item / dialog control) would otherwise reach the
// <Link> and navigate. Stopping it here (a React ancestor of the portal) keeps every portal click
// from triggering navigation.
export function DocMoreMenu({
  doc,
  workspaceId,
  projects,
  effectiveRole,
  canDelete = false,
}: {
  doc: DocRow;
  workspaceId: string;
  projects: ProjectRow[];
  /** the caller's effective role on this doc — gates the ShareDialog's manage surface (C-002).
   *  Absent on a browse row with no role signal → the dialog opens but shows the read-only
   *  surface (conservative). */
  effectiveRole?: EffectiveRole;
  /** doc-delete-trash S-001 / AS-004: whether the caller may delete this doc — (owner/editor) OR
   *  workspace-admin, decided by the caller. The Delete item is OFFERED only when true; a
   *  commenter/viewer never sees it. Defaults false (hidden) so a caller without a role signal
   *  cannot accidentally surface it. The backend is the hard gate regardless (403 on a refusal). */
  canDelete?: boolean;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveMode, setMoveMode] = useState<Mode>("move");
  const [shareOpen, setShareOpen] = useState(false);

  function openMove(mode: Mode) {
    setMoveMode(mode);
    setMoveOpen(true);
  }

  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={`doc-more-${doc.slug}`}
            aria-label="More actions"
            title="More actions"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            className="grid size-7 flex-none place-items-center rounded-md text-subtle hover:bg-elev hover:text-ink"
          >
            <Icon name="more" size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="border-line bg-surface">
          <DropdownMenuItem
            data-testid={`doc-more-share-${doc.slug}`}
            onSelect={(e) => {
              e.preventDefault();
              setShareOpen(true);
            }}
          >
            <Icon name="share" size={15} />
            Share…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid={`doc-more-move-${doc.slug}`}
            onSelect={(e) => {
              e.preventDefault();
              openMove("move");
            }}
          >
            <Icon name="arrowRight" size={15} />
            Move…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid={`doc-more-copy-${doc.slug}`}
            onSelect={(e) => {
              e.preventDefault();
              openMove("copy");
            }}
          >
            <Icon name="copy" size={15} />
            Copy…
          </DropdownMenuItem>
          {/* doc-delete-trash S-001 / AS-004: the Delete item is offered ONLY to a caller who may
              delete (owner/editor or workspace-admin). A commenter/viewer never sees it. It opens
              the DeleteDocDialog confirm (the menu item is the trigger, passed through asChild). */}
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DeleteDocDialog
                doc={doc}
                workspaceId={workspaceId}
                trigger={
                  <DropdownMenuItem
                    variant="destructive"
                    data-testid={`doc-more-delete-${doc.slug}`}
                    // Keep the menu item from closing the menu before the dialog opens.
                    onSelect={(e) => e.preventDefault()}
                  >
                    <Icon name="trash" size={15} />
                    Delete…
                  </DropdownMenuItem>
                }
              />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {moveOpen && (
        <MoveCopyDialog
          open={moveOpen}
          onOpenChange={setMoveOpen}
          doc={doc}
          workspaceId={workspaceId}
          projects={projects}
          initialMode={moveMode}
        />
      )}
      {shareOpen && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          workspaceId={workspaceId}
          slug={doc.slug}
          docTitle={doc.title}
          effectiveRole={effectiveRole}
        />
      )}
    </span>
  );
}
