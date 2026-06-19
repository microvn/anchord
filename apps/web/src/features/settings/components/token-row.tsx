import { Icon } from "@/components/icon";
import type { TokenListItem } from "@/features/settings/types/tokens";

// mcp-roundtrip S-001 (AS-020/AS-021) — one token row in the list: name + `anch_pat_…` prefix +
// workspace + scope chips + last-used + expiry + a Revoke button. The full token and its stored
// hash are NEVER part of this shape (the list endpoint returns metadata + prefix only — C-008),
// so there is nothing secret to render here.

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function expiryLabel(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function TokenRow({
  token,
  revoking,
  onRevoke,
}: {
  token: TokenListItem;
  revoking: boolean;
  onRevoke: (id: string) => void;
}) {
  return (
    <div
      data-testid={`token-row-${token.id}`}
      className="grid grid-cols-1 gap-3 border-b border-line px-5 py-3.5 last:border-b-0 sm:grid-cols-[1fr_auto] sm:gap-x-4"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
          {token.name}
          <span data-testid={`token-prefix-${token.id}`} className="font-mono text-[11px] text-subtle">
            {token.prefix}…
          </span>
        </div>
        <div className="mt-1.5 text-[11px] text-muted">
          <span data-testid={`token-workspace-${token.id}`} className="font-medium">
            {token.workspaceName ?? token.workspaceId}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {token.scopes.map((s) => (
            <span
              key={s}
              data-testid={`token-scope-chip-${token.id}-${s}`}
              className="rounded-[4px] bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] tracking-[0.02em] text-accent-ink"
            >
              {s}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="text-right">
          <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-faint">Last used</div>
          <div
            data-testid={`token-last-used-${token.id}`}
            className="mt-0.5 whitespace-nowrap text-[11.5px] tabular-nums text-muted"
          >
            {relativeTime(token.lastUsedAt)}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[9px] uppercase tracking-[0.08em] text-faint">Expires</div>
          <div
            data-testid={`token-expiry-${token.id}`}
            className="mt-0.5 whitespace-nowrap text-[11.5px] tabular-nums text-muted"
          >
            {expiryLabel(token.expiresAt)}
          </div>
        </div>
        <button
          type="button"
          data-testid={`token-revoke-${token.id}`}
          aria-label={`Revoke ${token.name}`}
          title="Revoke"
          disabled={revoking}
          onClick={() => onRevoke(token.id)}
          className="inline-grid size-8 place-items-center rounded-[7px] text-[var(--red,#f1655d)] hover:bg-[color-mix(in_oklab,var(--red,#f1655d)_10%,transparent)] disabled:opacity-50"
        >
          <Icon name="trash" size={15} />
        </button>
      </div>
    </div>
  );
}
