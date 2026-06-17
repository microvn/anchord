import type { AccessControls } from "@/features/sharing/hooks/use-access-controls";

// OptionsPanel (sharing-permissions-ui S-002) — the "Options" tab of the ShareDialog. Holds the two
// secondary toggles: guest commenting (gated to link, C-001) and the owner-only "editors can change
// sharing" toggle (C-003). Link protection (password / expiry / view-limit) used to live here too,
// but it moved to the Sharing tab inline under the access choice (AS-005) so the public-share flow
// costs no extra clicks. All state + writes live in the shared `useAccessControls` hook (so they
// share one PUT …/access with the access level on the Sharing tab); this panel only reads `controls`.

function ToggleRow({
  sectionTestid,
  toggleTestid,
  title,
  desc,
  on,
  disabled,
  onToggle,
}: {
  sectionTestid: string;
  toggleTestid: string;
  title: string;
  desc: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <section data-testid={sectionTestid} className="flex items-center gap-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-ink">{title}</div>
        <div className="text-[11.5px] text-subtle">{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={title}
        data-testid={toggleTestid}
        data-on={on ? "1" : "0"}
        disabled={disabled}
        onClick={onToggle}
        className={
          "relative h-[19px] w-[34px] flex-none rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
          (on ? "bg-accent" : "bg-faint")
        }
      >
        <span
          aria-hidden="true"
          className={
            "absolute top-0.5 left-0.5 h-[15px] w-[15px] rounded-full bg-white shadow-sm transition-transform " +
            (on ? "translate-x-[15px]" : "")
          }
        />
      </button>
    </section>
  );
}

export function OptionsPanel({
  controls,
}: {
  controls: AccessControls;
}) {
  const { isLink, isOwner, guestCommenting, editorsCanShare, saving, toggleGuest, toggleEditorsCanShare } = controls;

  return (
    <div data-testid="share-options" className="flex flex-col gap-4 pt-1">
      {/* Guest commenting — ENABLED only for anyone-with-link (C-001). */}
      <ToggleRow
        sectionTestid="share-sec-guest"
        toggleTestid="share-guest-toggle"
        title="Allow guest commenting"
        desc={isLink ? "Link visitors can comment without an account." : "Available only for Anyone with link."}
        on={guestCommenting}
        disabled={!isLink || saving}
        onToggle={toggleGuest}
      />

      {/* Editors can change sharing — owner-editable only (C-003); read-only for an editor. */}
      {isOwner ? (
        <ToggleRow
          sectionTestid="share-sec-editors-can-share"
          toggleTestid="share-editors-can-share-toggle"
          title="Editors can change sharing"
          desc="Let editors manage who can access this doc."
          on={editorsCanShare}
          disabled={saving}
          onToggle={toggleEditorsCanShare}
        />
      ) : (
        <section data-testid="share-sec-editors-can-share" className="flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-ink">Editors can change sharing</div>
            <div className="text-[11.5px] text-subtle">Only the owner can change this.</div>
          </div>
          <span
            data-testid="share-editors-can-share-readonly"
            data-on={editorsCanShare ? "1" : "0"}
            className="flex-none rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-muted"
          >
            {editorsCanShare ? "On" : "Off"}
          </span>
        </section>
      )}
    </div>
  );
}
