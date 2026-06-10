import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/icon";
import { queryKeys } from "../workspaces/query-keys";
import { unwrapEnvelope } from "../workspaces/use-bootstrap";
import { toApiError } from "../../lib/api-error";
import { moveDoc, copyDoc } from "./client";
import type { DocRow, ProjectRow } from "./types";

// MoveCopyDialog (workspace-project-ui S-001) — 1:1 with Anchord-Design dialogs2.jsx P10.
// A Move|Copy toggle (fmt-toggle), a destination project select-list (folder glyph · name ·
// Default badge · check on the selected), and a helper line. The destination list is the
// active workspace's projects ONLY (C-003) — the caller passes the workspace-scoped list.
// Move → POST …/docs/:slug/move; Copy → POST …/docs/:slug/copy (a clean duplicate, original
// stays). On success: invalidate the workspace docs + projects caches so the UI reflects the
// move (the doc's project label updates) / copy (a new doc appears in the target).

type Mode = "move" | "copy";

interface MoveCopyResult {
  docId: string;
  slug: string;
  projectId: string;
}

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
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(initialMode);
  // Pre-select a project that isn't the doc's current one (matches the prototype).
  const firstOther = projects.find((p) => p.id !== doc.projectId);
  const [target, setTarget] = useState<string>(firstOther?.id ?? projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    if (!target) return;
    setBusy(true);
    setError(null);
    const run = mode === "move" ? moveDoc : copyDoc;
    const targetName = projects.find((p) => p.id === target)?.name ?? "project";
    try {
      const res = unwrapEnvelope<MoveCopyResult>(await run(workspaceId, doc.slug, target));
      if (res.error) {
        setError(toApiError(res.error).message);
        setBusy(false);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.docs(workspaceId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
      toast.success(
        `${mode === "move" ? "Moved" : "Copied"} “${doc.title}” to ${targetName}`,
      );
      onOpenChange(false);
      setBusy(false);
    } catch (thrown) {
      setError(toApiError(thrown).message);
      setBusy(false);
    }
  }

  return (
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
            onClick={() => void onConfirm()}
          >
            <Icon name={mode === "move" ? "arrowRight" : "copy"} size={15} />
            {busy ? "Working…" : mode === "move" ? "Move" : "Copy"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The ⋯ button on a DocCard / DocList row. 1:1 with the Anchord-Design prototype: it opens the
// MoveCopyDialog DIRECTLY (the dialog carries the Move|Copy toggle) — there is NO intermediate
// Move/Copy menu. Self-contained so the grid card and the list row reuse it identically.
//
// The wrapper's onClick stops propagation: the kebab and the Radix Dialog are rendered inside the
// surrounding doc-card <Link>, and Radix portals the dialog to <body> but React still bubbles the
// portal's events UP THE REACT TREE — so a click inside the dialog (toggle / project / confirm)
// would otherwise reach the <Link> and navigate. Stopping it here (a React ancestor of the portal)
// keeps every dialog click from triggering navigation.
export function DocMoreMenu({
  doc,
  workspaceId,
  projects,
}: {
  doc: DocRow;
  workspaceId: string;
  projects: ProjectRow[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-testid={`doc-more-${doc.slug}`}
        aria-label="More actions"
        title="Move or copy"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        className="grid size-7 flex-none place-items-center rounded-md text-subtle hover:bg-elev hover:text-ink"
      >
        <Icon name="more" size={16} />
      </button>
      {open && (
        <MoveCopyDialog
          open={open}
          onOpenChange={setOpen}
          doc={doc}
          workspaceId={workspaceId}
          projects={projects}
        />
      )}
    </span>
  );
}
