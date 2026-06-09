import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useActiveWorkspace } from "./active-workspace";
import { renameWorkspace } from "./client";
import { unwrapEnvelope } from "./use-bootstrap";
import { queryKeys } from "./query-keys";
import { toApiError } from "../../lib/api-error";

// S-002 RenameField (AS-005, AS-006 / C-002): rename the active workspace. ADMIN-ONLY — a
// non-admin sees NO rename affordance at all (the component renders null). On success we
// invalidate the bootstrap so the new name shows everywhere the active workspace is read
// (switcher + top bar), since both derive from the bootstrap list.
export function RenameField() {
  const { workspace, isAdmin } = useActiveWorkspace();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // C-002: admin-only control. A non-admin gets no affordance (not just disabled — absent).
  if (!isAdmin) return null;

  if (!editing) {
    return (
      <button
        type="button"
        data-testid="rename-edit"
        onClick={() => {
          setName(workspace.name);
          setError(null);
          setEditing(true);
        }}
        className="min-h-[40px] rounded-md border border-line bg-surface px-3 text-sm text-ink hover:border-accent"
      >
        Rename workspace
      </button>
    );
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
    setEditing(false);
  }

  return (
    <form onSubmit={save} className="flex items-center gap-2">
      <input
        data-testid="rename-input"
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
      <button
        type="submit"
        data-testid="rename-save"
        disabled={busy}
        className="min-h-[40px] rounded-md bg-accent px-3 text-sm font-medium text-on-accent disabled:opacity-60"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="min-h-[40px] rounded-md px-3 text-sm text-muted hover:text-ink"
      >
        Cancel
      </button>
    </form>
  );
}
