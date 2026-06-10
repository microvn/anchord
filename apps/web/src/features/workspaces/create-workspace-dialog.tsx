import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { createWorkspace, setActiveWorkspace } from "./client";
import { unwrapEnvelope } from "./use-bootstrap";
import { queryKeys } from "./query-keys";
import { toApiError } from "../../lib/api-error";

// S-002 CreateWorkspaceDialog (AS-004): create a workspace; the creator becomes admin and the
// app SWITCHES into it. On success we refetch the bootstrap (so the new workspace appears in
// the switcher) and navigate to `/w/:newId/` (which re-scopes the app via the route guard).
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
    <div
      role="dialog"
      aria-label="Create workspace"
      data-testid="create-workspace-dialog"
      className="absolute left-0 z-30 mt-1 w-72 rounded-md border border-line bg-elev p-3 shadow-lg"
    >
      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm text-ink" htmlFor="ws-name">
          Workspace name
        </label>
        <input
          id="ws-name"
          data-testid="create-workspace-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          className="min-h-[40px] rounded-md border border-line bg-surface px-3 text-sm text-ink focus:border-accent focus:outline-none"
        />
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] rounded-md px-3 text-sm text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="create-workspace-submit"
            disabled={busy}
            className="min-h-[40px] rounded-md bg-accent px-3 text-sm font-medium text-on-accent disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
