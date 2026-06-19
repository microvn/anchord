import { Icon } from "@/components/icon";

// account-settings S-001 / C-006: a generic coming-soon body for a reserved slot that has no
// owning feature yet (Developer/Notifications/Security). S-004 finalizes the visual; for the
// shell we just need a controls-free "Soon" state so a reserved section renders something real
// instead of an empty page. (Anchord-Design/settings.jsx ComingSoon.)
export function ComingSoonSection({
  title,
  sub,
  owner,
  icon,
}: {
  title: string;
  sub: string;
  owner?: string;
  icon: string;
}) {
  return (
    <div
      data-testid="settings-coming-soon"
      className="flex flex-col items-center gap-2.5 rounded-[12px] border border-line bg-surface px-6 py-11 text-center"
    >
      {/* .soon-icon — a bordered grey square chip, not a teal pill. */}
      <span className="inline-flex size-10 items-center justify-center rounded-md border border-line bg-elev text-subtle">
        <Icon name={icon} size={20} />
      </span>
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      <div className="max-w-[340px] text-[12.5px] leading-relaxed text-muted">{sub}</div>
      {owner && (
        <div className="mt-1 font-mono text-[10.5px] tracking-wide text-subtle">{owner}</div>
      )}
    </div>
  );
}
