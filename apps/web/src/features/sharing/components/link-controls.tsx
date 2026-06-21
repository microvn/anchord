import { useState } from "react";
import { format, startOfToday } from "date-fns";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { setLinkControls, type ShareLink, type SetLinkInput } from "@/features/sharing/services/client";

// LinkControls (sharing-permissions-ui S-005) — the PROTECTION chips for the capability link:
// three INDEPENDENT chips (password / expiry / view-limit, C-001) that gate the `/s/<token>`
// capability link (S-006 enforces them at redeem). Clicking an unset chip reveals an inline editor;
// confirming optimistically marks the chip "set" and sends ONLY that control to PUT /link; a
// refused/failed write reverts the chip + shows an error (C-005/AS-017). Clicking a set chip clears
// that one control.
//
// Rendered directly UNDER CapabilityLinkRow (the external `/s/<token>` link these controls protect),
// only when general-access is anyone-with-link — the parent gates rendering. It no longer shows a
// copyable URL: the in-app readable `/d/<slug>` address is NOT an external share link and surfacing
// it competed with the capability link + leaked the guessable slug (capability-share-link C-009).

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
  // The actual set VALUES, so a "set" chip shows WHAT it's set to (the expiry date, the view limit)
  // — not a bare "· set". Password has no displayable value (it's hashed) → shown as "· on".
  const [vals, setVals] = useState<{ expiry: string | null; limit: number | null }>({
    expiry: link.expiresAt ?? null,
    limit: link.viewLimit ?? null,
  });
  const [editing, setEditing] = useState<ChipKey | null>(null);
  const [draft, setDraft] = useState("");

  // Build the single-control payload for a chip (C-001: only the changed control is sent).
  function payloadFor(key: ChipKey, value: string | null): SetLinkInput {
    if (key === "password") return { password: value };
    if (key === "expiry") return { expiresAt: value };
    return { viewLimit: value == null ? null : Number(value) };
  }

  async function commit(key: ChipKey, value: string | null) {
    const set = value != null;
    const prev = chips[key];
    const prevVals = vals;
    // optimistic: reflect the new chip state + its value immediately.
    setChips((c) => ({ ...c, [key]: set }));
    if (key === "expiry") setVals((v) => ({ ...v, expiry: value }));
    if (key === "limit") setVals((v) => ({ ...v, limit: value == null ? null : Number(value) }));
    setEditing(null);
    setDraft("");
    const res = await setLinkControls(workspaceId, slug, payloadFor(key, value));
    if (res.error || !res.data) {
      // AS-017/C-005: revert the chip + its value + error, no partial state.
      setChips((c) => ({ ...c, [key]: prev }));
      setVals(prevVals);
      toast.error("Couldn't update the link");
    }
  }

  // The label of a SET chip — shows the value (expiry date / view limit), not a bare "· set".
  function setLabel(key: ChipKey): string {
    if (key === "password") return "Password · on";
    if (key === "expiry") {
      return vals.expiry ? `Expiry · ${format(new Date(vals.expiry), "MMM d, yyyy")}` : "Expiry · set";
    }
    return vals.limit != null ? `View limit · ${vals.limit}` : "View limit · set";
  }

  return (
    <section data-testid="share-sec-link" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(CHIP_META) as ChipKey[]).map((key) => {
          const meta = CHIP_META[key];
          const on = chips[key];
          // The chip reads "active" (accent) when its control is SET, OR while its inline editor is
          // open — otherwise clicking "+ Password" opened the editor with no visible active state.
          const active = on || editing === key;
          return (
            <span key={key} className="inline-flex items-center">
              <button
                type="button"
                data-testid={meta.testid}
                data-on={on ? "1" : "0"}
                data-active={active ? "1" : "0"}
                onClick={() => {
                  if (on) return void commit(key, null); // a set chip → clear that control
                  setEditing((cur) => (cur === key ? null : key)); // toggle this chip's editor
                  setDraft("");
                }}
                className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle transition-colors hover:text-ink data-[active=1]:border-accent data-[active=1]:bg-accent-soft data-[active=1]:text-accent-ink"
              >
                <Icon name={meta.icon} size={12} />
                {on ? setLabel(key) : editing === key ? meta.label : `+ ${meta.label}`}
              </button>
            </span>
          );
        })}
      </div>

      {/* Expiry uses a real date picker (shadcn Popover + Calendar) — no free-typed YYYY-MM-DD, and
          past dates are disabled so an expiry can't be set already-in-the-past. Selecting a day
          commits immediately (expiresAt as ISO; the backend coerces it). */}
      {editing === "expiry" && (
        <Popover
          open
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid="share-link-editor-expiry"
              className="inline-flex h-8 items-center gap-2 self-start rounded-[6px] border border-line bg-surface px-2.5 text-[12.5px] text-subtle transition-colors hover:text-ink"
            >
              <Icon name="clock" size={13} />
              {draft ? format(new Date(draft), "MMM d, yyyy") : "Pick a date"}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0">
            <Calendar
              mode="single"
              selected={draft ? new Date(draft) : undefined}
              onSelect={(d) => {
                if (d) {
                  setDraft(d.toISOString());
                  void commit("expiry", d.toISOString());
                }
              }}
              disabled={{ before: startOfToday() }}
              autoFocus
            />
          </PopoverContent>
        </Popover>
      )}

      {editing && editing !== "expiry" && (
        <form
          data-testid={`share-link-editor-${editing}`}
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim().length > 0) void commit(editing, draft.trim());
          }}
        >
          <Input
            data-testid="share-link-editor-input"
            type={editing === "password" ? "password" : "number"}
            min={editing === "limit" ? 1 : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={CHIP_META[editing].placeholder}
            autoFocus
            className="h-8 flex-1 text-[12.5px]"
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
