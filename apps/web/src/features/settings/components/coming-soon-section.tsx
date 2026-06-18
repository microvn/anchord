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
      className="rounded-[12px] border border-line bg-elev p-8 text-center"
    >
      <span className="mx-auto mb-3 inline-flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
        <Icon name={icon} size={20} />
      </span>
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      <div className="mx-auto mt-1.5 max-w-[42ch] text-[12.5px] leading-relaxed text-subtle">
        {sub}
      </div>
      {owner && (
        <div className="mt-3 font-mono text-[10.5px] uppercase tracking-wide text-faint">
          {owner}
        </div>
      )}
    </div>
  );
}
