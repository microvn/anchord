import { useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { setLinkControls, type ShareLink, type SetLinkInput } from "@/features/sharing/services/client";

// LinkControls (sharing-permissions-ui S-005) — the Link section for an anyone-with-link doc:
// the share URL + a Copy button (AS-015), and three INDEPENDENT chips (password / expiry /
// view-limit, C-001). Clicking an unset chip reveals an inline editor; confirming optimistically
// marks the chip "set" and sends ONLY that control to PUT /link; a refused/failed write reverts
// the chip + shows an error (C-005/AS-017). Clicking a set chip clears that one control.
//
// Shown only when general-access is anyone-with-link (C-007) — the parent gates rendering.

type ChipKey = "password" | "expiry" | "limit";

interface ChipState {
  password: boolean;
  expiry: boolean;
  limit: boolean;
}

const CHIP_META: Record<ChipKey, { icon: string; label: string; placeholder: string; testid: string }> = {
  password: { icon: "shield", label: "Password", placeholder: "Set a password", testid: "share-link-password" },
  expiry: { icon: "clock", label: "Expiry", placeholder: "YYYY-MM-DD", testid: "share-link-expiry" },
  limit: { icon: "user", label: "View limit", placeholder: "Max views", testid: "share-link-limit" },
};

export function LinkControls({
  workspaceId,
  slug,
  link,
}: {
  workspaceId: string;
  slug: string;
  link: ShareLink;
}) {
  const [chips, setChips] = useState<ChipState>({
    password: link.hasPassword,
    expiry: link.expiresAt != null,
    limit: link.viewLimit != null,
  });
  const [editing, setEditing] = useState<ChipKey | null>(null);
  const [draft, setDraft] = useState("");

  async function copy() {
    await navigator.clipboard?.writeText(link.url);
    toast.success("Link copied");
  }

  // Build the single-control payload for a chip (C-001: only the changed control is sent).
  function payloadFor(key: ChipKey, value: string | null): SetLinkInput {
    if (key === "password") return { password: value };
    if (key === "expiry") return { expiresAt: value };
    return { viewLimit: value == null ? null : Number(value) };
  }

  async function commit(key: ChipKey, value: string | null) {
    const set = value != null;
    const prev = chips[key];
    // optimistic: reflect the new chip state immediately.
    setChips((c) => ({ ...c, [key]: set }));
    setEditing(null);
    setDraft("");
    const res = await setLinkControls(workspaceId, slug, payloadFor(key, value));
    if (res.error || !res.data) {
      // AS-017/C-005: revert the chip + error, no partial state.
      setChips((c) => ({ ...c, [key]: prev }));
      toast.error("Couldn't update the link");
    }
  }

  return (
    <section data-testid="share-sec-link" className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-muted">Link</span>
      <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-2.5 py-1.5">
        <Icon name="link" size={14} />
        <code data-testid="share-link-url" className="min-w-0 flex-1 truncate text-[12px] text-ink">
          {link.url}
        </code>
        <button
          type="button"
          data-testid="share-link-copy"
          onClick={() => void copy()}
          className="inline-flex h-7 flex-none items-center gap-1 rounded-[6px] border border-line px-2 text-[12px] font-medium text-muted transition-colors hover:text-ink"
        >
          <Icon name="copy" size={13} /> Copy
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(CHIP_META) as ChipKey[]).map((key) => {
          const meta = CHIP_META[key];
          const on = chips[key];
          return (
            <span key={key} className="inline-flex items-center">
              <button
                type="button"
                data-testid={meta.testid}
                data-on={on ? "1" : "0"}
                onClick={() => (on ? void commit(key, null) : setEditing(key))}
                className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle transition-colors hover:text-ink data-[on=1]:border-accent data-[on=1]:text-accent-ink"
              >
                <Icon name={meta.icon} size={12} />
                {on ? `${meta.label} · set` : `+ ${meta.label}`}
              </button>
            </span>
          );
        })}
      </div>

      {editing && (
        <form
          data-testid={`share-link-editor-${editing}`}
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim().length > 0) void commit(editing, draft.trim());
          }}
        >
          <input
            data-testid="share-link-editor-input"
            type={editing === "password" ? "password" : editing === "limit" ? "number" : "text"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={CHIP_META[editing].placeholder}
            autoFocus
            className="h-8 min-w-0 flex-1 rounded-[6px] border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
          />
          <button
            type="submit"
            data-testid="share-link-editor-set"
            disabled={draft.trim().length === 0}
            className="inline-flex h-8 flex-none items-center rounded-[6px] bg-accent px-3 text-[12px] font-semibold text-on-accent transition-colors hover:bg-accent-strong disabled:opacity-50"
          >
            Set
          </button>
        </form>
      )}
    </section>
  );
}
