import { useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import {
  SCOPE_OPTIONS,
  SCOPE_PRESETS,
  type CreateTokenInput,
  type TokenScope,
} from "@/features/settings/types/tokens";
import type { WorkspaceListItem } from "@/features/workspaces/types";
import { workspaceLabel } from "@/features/workspaces/types";

// mcp-roundtrip S-001 — the create-token dialog. Ports Anchord-Design/settings-dev.jsx's
// CreateTokenDialog shape (name field → workspace picker → preset chips + scope checkboxes →
// expiry toggle), but with the spec-authoritative 6 scopes / 3 presets (AS/Constraints win over
// the stale 4-scope prototype). The token IS bound to one workspace at creation — so THIS dialog
// keeps a workspace picker (POST body `workspaceId`); only the MCP-connect block drops its picker.

function sameSet(a: TokenScope[], b: TokenScope[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

export function CreateTokenDialog({
  workspaces,
  submitting,
  error,
  onCancel,
  onCreate,
}: {
  workspaces: WorkspaceListItem[];
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (input: CreateTokenInput) => void;
}) {
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [scopes, setScopes] = useState<TokenScope[]>(["docs:read", "annotations:read", "projects:read"]);
  const [expiryMode, setExpiryMode] = useState<"never" | "date">("never");
  const [date, setDate] = useState("");

  const activePreset = useMemo(
    () => SCOPE_PRESETS.find((p) => sameSet(p.scopes, scopes))?.label ?? null,
    [scopes],
  );

  const toggle = (s: TokenScope) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const trimmedName = name.trim();
  const noName = trimmedName.length === 0;
  const noScopes = scopes.length === 0;
  const dateMissing = expiryMode === "date" && !date;
  const canCreate = !noName && !noScopes && !dateMissing && !submitting && workspaceId !== "";

  function handleCreate() {
    if (!canCreate) return;
    onCreate({
      name: trimmedName,
      workspaceId,
      scopes,
      expiresAt: expiryMode === "date" ? new Date(date).toISOString() : undefined,
    });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Generate access token"
      data-testid="create-token-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button
        type="button"
        aria-label="Close"
        data-testid="create-token-scrim"
        className="fixed inset-0 bg-black/50"
        onClick={onCancel}
      />
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-[520px] flex-col overflow-hidden rounded-[12px] border border-line bg-elev shadow-lg">
        <div className="border-b border-line px-5 py-4">
          <div className="text-[15px] font-semibold text-ink">Generate access token</div>
          <div className="mt-1 text-[12px] text-subtle">
            Tokens are bound to one workspace and the scopes you pick.
          </div>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-5">
          {/* Token name */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token-name" className="text-[12.5px] font-medium text-ink">
              Token name
            </label>
            <input
              id="token-name"
              data-testid="token-name"
              className="rounded-[7px] border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mara · MacBook Pro"
              autoFocus
            />
            <span className="text-[11.5px] text-subtle">
              Name it after the machine or service that will use it.
            </span>
          </div>

          {/* Workspace picker — the token IS bound to one workspace at creation (POST workspaceId). */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="token-workspace" className="text-[12.5px] font-medium text-ink">
              Workspace
            </label>
            <select
              id="token-workspace"
              data-testid="token-workspace"
              className="rounded-[7px] border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {workspaceLabel(w)}
                </option>
              ))}
            </select>
            <span className="text-[11.5px] text-subtle">The token can only act inside this workspace.</span>
          </div>

          {/* Scopes — 6 checkboxes + 3 presets */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Scopes</span>
            <div className="mb-1 flex flex-wrap gap-1.5">
              {SCOPE_PRESETS.map((p) => {
                const active = activePreset === p.label;
                return (
                  <button
                    key={p.label}
                    type="button"
                    data-testid={`token-preset-${p.label}`}
                    onClick={() => setScopes([...p.scopes])}
                    className={`h-7 rounded-full border px-3 font-mono text-[11px] font-semibold transition-colors ${
                      active
                        ? "border-transparent bg-accent-soft text-accent-ink"
                        : "border-line bg-surface text-muted hover:border-subtle hover:text-ink"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col gap-1.5">
              {SCOPE_OPTIONS.map((s) => {
                const on = scopes.includes(s.id);
                return (
                  <button
                    type="button"
                    key={s.id}
                    role="checkbox"
                    aria-checked={on}
                    data-testid={`token-scope-${s.id}`}
                    onClick={() => toggle(s.id)}
                    className={`flex items-start gap-2.5 rounded-[8px] border px-3 py-2.5 text-left transition-colors ${
                      on ? "border-accent bg-accent-soft" : "border-line hover:border-subtle"
                    }`}
                  >
                    <span
                      className={`mt-0.5 grid size-[17px] flex-none place-items-center rounded-[5px] border-[1.5px] ${
                        on ? "border-accent bg-accent text-on-accent" : "border-faint text-transparent"
                      }`}
                    >
                      <Icon name="check" size={12} />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-mono text-[12px] font-medium text-ink">{s.id}</span>
                      <span className="mt-0.5 block text-[11.5px] text-subtle">{s.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {noScopes && (
              <span data-testid="token-scope-error" className="text-[11.5px] text-[var(--red,#f1655d)]">
                Pick at least one scope.
              </span>
            )}
          </div>

          {/* Expiry */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Expiration</span>
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-[7px] border border-line p-0.5">
                <button
                  type="button"
                  data-testid="token-expiry-never"
                  onClick={() => setExpiryMode("never")}
                  className={`rounded-[5px] px-3 py-1 text-[12px] font-medium ${
                    expiryMode === "never" ? "bg-accent-soft text-accent-ink" : "text-muted"
                  }`}
                >
                  Never
                </button>
                <button
                  type="button"
                  data-testid="token-expiry-date"
                  onClick={() => setExpiryMode("date")}
                  className={`rounded-[5px] px-3 py-1 text-[12px] font-medium ${
                    expiryMode === "date" ? "bg-accent-soft text-accent-ink" : "text-muted"
                  }`}
                >
                  On a date
                </button>
              </div>
              {expiryMode === "date" && (
                <input
                  type="date"
                  data-testid="token-expiry-input"
                  className="max-w-[180px] rounded-[7px] border border-line bg-surface px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              )}
            </div>
          </div>

          {error && (
            <div
              data-testid="create-token-error"
              className="rounded-[7px] border border-[var(--red,#f1655d)] bg-[color-mix(in_oklab,var(--red,#f1655d)_8%,transparent)] px-3 py-2 text-[12px] text-[var(--red,#f1655d)]"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-line px-5 py-3.5">
          <button
            type="button"
            data-testid="create-token-cancel"
            onClick={onCancel}
            className="inline-flex h-9 items-center rounded-[7px] border border-line bg-surface px-3.5 text-[12.5px] font-medium text-ink hover:bg-elev"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="create-token-submit"
            disabled={!canCreate}
            onClick={handleCreate}
            className="inline-flex h-9 items-center gap-2 rounded-[7px] bg-accent px-3.5 text-[12.5px] font-semibold text-on-accent hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon name="plus" size={15} />
            Generate token
          </button>
        </div>
      </div>
    </div>
  );
}
