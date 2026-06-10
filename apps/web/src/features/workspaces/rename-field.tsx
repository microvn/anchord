import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveWorkspace } from "./active-workspace";
import { renameWorkspace } from "./client";
import { unwrapEnvelope } from "./use-bootstrap";
import { queryKeys } from "./query-keys";
import { toApiError } from "../../lib/api-error";
import { Icon } from "../../components/icon";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

// S-002 RenameField (AS-005, AS-006 / C-002): rename the active workspace. ADMIN-ONLY — a
// non-admin sees NO rename affordance at all (the component renders null). On success we
// invalidate the bootstrap so the new name shows everywhere the active workspace is read
// (switcher + top bar), since both derive from the bootstrap list.
//
// Presentation: the trigger is a page-head "Rename workspace" button (`rename-edit`); clicking
// it opens a CENTERED modal + scrim — the shadcn Dialog primitive themed to Anchord-Design's
// `.dialog`/`.scrim` (box 440 / radius 11 / shadow-modal; title Mono 21; input h36/r8; buttons
// h32/r8). Consumers (workspace-home + members page-head) embed `<RenameField />` as-is.
export function RenameField() {
  const { workspace, isAdmin } = useActiveWorkspace();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // C-002: admin-only control. A non-admin gets no affordance (not just disabled — absent).
  if (!isAdmin) return null;

  function openDialog() {
    setName(workspace.name);
    setError(null);
    setOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a workspace name.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = unwrapEnvelope<{ id: string; name: string }>(
      await renameWorkspace(workspace.id, trimmed),
    );
    if (result.error) {
      setError(toApiError(result.error).message);
      setBusy(false);
      return;
    }
    // The new name lives in the bootstrap list — refetch so switcher + top bar both update.
    await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap() });
    setBusy(false);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        data-testid="rename-edit"
        onClick={openDialog}
        className="inline-flex h-8 items-center gap-[7px] rounded-[8px] px-3 text-[12.5px] font-semibold text-muted transition-colors hover:bg-elev hover:text-ink"
      >
        <Icon name="pencil" size={15} />
        Rename workspace
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-label="Rename workspace"
          aria-describedby={undefined}
          data-testid="rename-workspace-dialog"
          // Anchord-Design `.scrim` — full-viewport teal-black scrim (the --scrim token).
          overlayClassName="bg-[var(--scrim)]"
          // Anchord-Design `.dialog`: 440 wide, radius 11, line border, shadow-modal, no inner
          // padding (head/body/foot own their own). gap-0 cancels shadcn's default grid gap.
          className="w-full max-w-[440px] gap-0 rounded-[11px] border border-line bg-surface p-0 shadow-[var(--shadow-modal)] sm:max-w-[440px]"
        >
          <form onSubmit={save}>
            {/* head — 18/18/0 */}
            <DialogHeader className="gap-0 p-[18px] pb-0 text-left">
              <DialogTitle className="font-serif text-[21px] font-medium leading-[1.05] tracking-[-0.03em] text-ink">
                Rename workspace
              </DialogTitle>
            </DialogHeader>

            {/* body — 16/18 */}
            <div className="px-[18px] py-4">
              <label
                htmlFor="rename-input"
                className="mb-1.5 block text-[12.5px] font-medium text-ink"
              >
                Workspace name
              </label>
              <input
                id="rename-input"
                data-testid="rename-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="h-9 w-full rounded-[8px] border border-line bg-surface px-[11px] text-[13.5px] text-ink outline-none placeholder:text-subtle focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
              />
              {error && (
                <p role="alert" className="mt-2 text-[12.5px] text-error">
                  {error}
                </p>
              )}
            </div>

            {/* foot — 0/18/18, gap 8, justify-end */}
            <div className="flex justify-end gap-2 px-[18px] pb-[18px]">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-8 items-center gap-[7px] rounded-[8px] border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink transition-colors hover:border-subtle hover:bg-elev"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="rename-save"
                disabled={busy}
                className="inline-flex h-8 items-center gap-[7px] rounded-[8px] bg-accent px-3 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
