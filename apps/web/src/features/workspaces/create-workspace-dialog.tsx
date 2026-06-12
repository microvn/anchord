import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { createWorkspace, setActiveWorkspace } from "./client";
import { unwrapEnvelope } from "./use-bootstrap";
import { queryKeys } from "./query-keys";
import { toApiError } from "@/lib/api/api-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// S-002 CreateWorkspaceDialog (AS-004): create a workspace; the creator becomes admin and the
// app SWITCHES into it. On success we refetch the bootstrap (so the new workspace appears in
// the switcher) and navigate to `/w/:newId/` (which re-scopes the app via the route guard).
//
// Presentation: a CENTERED modal + full-viewport scrim — the shadcn Dialog primitive, themed to
// the Anchord-Design `.dialog`/`.scrim` (box 440 / radius 11 / shadow-modal; head 18/18/0,
// title Mono 21, body 16/18, foot 0/18/18 gap 8). The trigger lives in the sidebar switcher,
// which owns open/close, so this component takes `onClose` and renders an always-open Dialog.
interface CreatedWorkspace {
  id: string;
}

export function CreateWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a workspace name.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = unwrapEnvelope<CreatedWorkspace>(await createWorkspace(trimmed));
    if (result.error || !result.data) {
      setError(toApiError(result.error).message);
      setBusy(false);
      return;
    }
    const newId = result.data.id;
    // Make the new workspace visible in the switcher, then switch into it (AS-004).
    await queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap() });
    try {
      await setActiveWorkspace(newId);
    } catch {
      /* best-effort landing default (C-005); the route switch below is the real scope change */
    }
    navigate(`/w/${newId}/`);
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-label="Create workspace"
        data-testid="create-workspace-dialog"
        // Anchord-Design `.scrim` — full-viewport teal-black scrim (the --scrim token).
        overlayClassName="bg-[var(--scrim)]"
        // Anchord-Design `.dialog`: 440 wide, radius 11, line border, shadow-modal, no inner
        // padding (head/body/foot own their own). gap-0 cancels shadcn's default grid gap.
        className="w-full max-w-[440px] gap-0 rounded-[11px] border border-line bg-surface p-0 shadow-[var(--shadow-modal)] sm:max-w-[440px]"
      >
        <form onSubmit={submit}>
          {/* head — 18/18/0 */}
          <DialogHeader className="gap-0 p-[18px] pb-0 text-left">
            <DialogTitle className="font-serif text-[21px] font-medium leading-[1.05] tracking-[-0.03em] text-ink">
              New workspace
            </DialogTitle>
            <DialogDescription className="mt-[3px] text-[12.5px] text-muted">
              A separate space for a team, client, or project set.
            </DialogDescription>
          </DialogHeader>

          {/* body — 16/18 */}
          <div className="px-[18px] py-4">
            <label htmlFor="ws-name" className="mb-1.5 block text-[12.5px] font-medium text-ink">
              Name
            </label>
            <input
              id="ws-name"
              data-testid="create-workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              placeholder="e.g. Acme Platform"
              className="h-9 w-full rounded-[8px] border border-line bg-surface px-[11px] text-[13.5px] text-ink outline-none placeholder:text-subtle focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            />
            <p className="mt-[7px] text-[11.5px] text-subtle">
              You’ll be the admin. You can rename or invite people later.
            </p>
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
              onClick={onClose}
              className="inline-flex h-8 items-center gap-[7px] rounded-[8px] border border-line bg-surface px-3 text-[12.5px] font-semibold text-ink transition-colors hover:border-subtle hover:bg-elev"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="create-workspace-submit"
              disabled={busy}
              className="inline-flex h-8 items-center gap-[7px] rounded-[8px] bg-accent px-3 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create workspace"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
