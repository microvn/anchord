import { Icon } from "@/components/icon";
import {
  useNotificationPreferences,
  useUpdateNotificationPreference,
} from "@/features/notifications/hooks/use-notification-preferences";
import {
  PREF_GROUPS,
  isHiddenType,
  metaForType,
  type PrefGroupId,
} from "@/features/notifications/lib/notification-pref-meta";
import type {
  EffectivePreference,
  NotificationPreferences,
  PrefChannel,
} from "@/features/notifications/types/preferences";

// notification-preferences S-003 — Settings → Notifications. Per-event, per-channel toggles grouped
// sensibly, with critical in-app notices locked-on (C-002) and a deferred daily-digest row (C-004).
//
// AS-012 (SEAM): the ROW SET is derived from the LIVE taxonomy the API returns — `prefs.preferences`
// — NOT a hardcoded FE list. One row per firing type with its supported channels; a type the FE
// grouping map doesn't recognize still renders (default "Other" group). Add a type/channel to the
// backend matrix and the row appears here with no FE change.
//
// GAP-001 (AS-009): live per-toggle save — optimistic, toast on failure, no Save button.

// A single channel toggle (In-app or Email). Renders nothing when the channel is unsupported for
// the type (the backend marks `supported: false`). A locked channel is shown ON + disabled (C-002).
function ChannelToggle({
  pref,
  channelLabel,
  onToggle,
  pending,
}: {
  pref: EffectivePreference;
  channelLabel: string;
  onToggle: (next: boolean) => void;
  pending: boolean;
}) {
  if (!pref.supported) return null;
  const disabled = pref.locked || pending;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-subtle">{channelLabel}</span>
      <button
        type="button"
        role="switch"
        aria-checked={pref.enabled}
        aria-label={`${channelLabel}${pref.locked ? " (locked on)" : ""}`}
        data-testid={`pref-toggle-${pref.type}-${pref.channel}`}
        data-on={pref.enabled ? "1" : "0"}
        data-locked={pref.locked ? "1" : "0"}
        disabled={disabled}
        onClick={() => onToggle(!pref.enabled)}
        className={
          "relative h-[19px] w-[34px] flex-none rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 " +
          (pref.enabled ? "bg-accent" : "bg-faint")
        }
      >
        <span
          aria-hidden="true"
          className={
            "absolute top-0.5 left-0.5 h-[15px] w-[15px] rounded-full bg-white shadow-sm transition-transform " +
            (pref.enabled ? "translate-x-[15px]" : "")
          }
        />
      </button>
    </div>
  );
}

// One event row: label + description on the left, its supported channel toggles on the right.
function NotificationPrefRow({
  type,
  byChannel,
  onToggle,
  pending,
}: {
  type: string;
  byChannel: Partial<Record<PrefChannel, EffectivePreference>>;
  onToggle: (channel: PrefChannel, enabled: boolean) => void;
  pending: boolean;
}) {
  const meta = metaForType(type);
  const inApp = byChannel.in_app;
  const email = byChannel.email;
  return (
    <div
      data-testid={`pref-row-${type}`}
      className="flex flex-col gap-2 border-t border-line px-5 py-3.5 first:border-t-0 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-ink">{meta.label}</div>
        {meta.description && (
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-subtle">{meta.description}</div>
        )}
      </div>
      <div className="flex items-center gap-5">
        {inApp && (
          <ChannelToggle
            pref={inApp}
            channelLabel="In-app"
            pending={pending}
            onToggle={(next) => onToggle("in_app", next)}
          />
        )}
        {email && (
          <ChannelToggle
            pref={email}
            channelLabel="Email"
            pending={pending}
            onToggle={(next) => onToggle("email", next)}
          />
        )}
      </div>
    </div>
  );
}

// The deferred daily-digest row — email-only, off, disabled (C-004). Not a real notification type;
// it is a UI placeholder so users see it's coming, and it never becomes enable-able by toggling
// anything else (it has no wiring at all).
function DigestPrefRow() {
  return (
    <div
      data-testid="pref-row-digest"
      className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-ink">
          Daily email digest
          <span
            data-testid="digest-coming-soon"
            className="ml-2 rounded-[4px] border border-line bg-elev px-1.5 py-0.5 align-middle text-[10px] font-medium text-subtle"
          >
            Coming soon
          </span>
        </div>
        <div className="mt-0.5 text-[11.5px] leading-relaxed text-subtle">
          A once-a-day summary email instead of per-event mail. Not available yet.
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-subtle">Email</span>
        <button
          type="button"
          role="switch"
          aria-checked={false}
          aria-label="Daily email digest (coming soon)"
          data-testid="pref-toggle-digest-email"
          data-on="0"
          disabled
          className="relative h-[19px] w-[34px] flex-none cursor-not-allowed rounded-full bg-faint opacity-60"
        >
          <span
            aria-hidden="true"
            className="absolute top-0.5 left-0.5 h-[15px] w-[15px] rounded-full bg-white shadow-sm"
          />
        </button>
      </div>
    </div>
  );
}

// Group rendered rows by the FE grouping map. The ROW SET (which types) comes from the live API
// taxonomy; the map only decides WHICH group and the COPY (AS-012).
function groupRows(prefs: NotificationPreferences) {
  // Collapse the flat (type, channel) list into one entry per type, carrying both channels.
  const byType = new Map<string, Partial<Record<PrefChannel, EffectivePreference>>>();
  const order: string[] = [];
  for (const p of prefs.preferences) {
    if (isHiddenType(p.type)) continue; // legacy alias (reply) is never a user-facing row
    if (!byType.has(p.type)) {
      byType.set(p.type, {});
      order.push(p.type);
    }
    byType.get(p.type)![p.channel] = p;
  }

  const groups = new Map<PrefGroupId, string[]>();
  for (const type of order) {
    const groupId = metaForType(type).group;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId)!.push(type);
  }

  return Array.from(groups.entries())
    .map(([groupId, types]) => ({ group: PREF_GROUPS[groupId], types }))
    .sort((a, b) => a.group.order - b.group.order)
    .map((g) => ({
      ...g,
      rows: g.types.map((type) => ({ type, byChannel: byType.get(type)! })),
    }));
}

function GroupCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div data-testid={`pref-group-${title}`} className="rounded-[12px] border border-line bg-elev">
      <div className="px-5 pt-4 pb-2 text-[12.5px] font-semibold text-ink">{title}</div>
      <div>{children}</div>
    </div>
  );
}

export function NotificationsSettingsSection() {
  const prefsQuery = useNotificationPreferences();
  const updatePref = useUpdateNotificationPreference();

  if (prefsQuery.isError) {
    return (
      <div data-testid="prefs-error" className="rounded-[12px] border border-line bg-elev p-8 text-[12.5px] text-subtle">
        We couldn&rsquo;t load your notification preferences. Reload to try again.
      </div>
    );
  }

  // Read pending / empty → render nothing toggle-able yet (matrix defaults arrive with the read).
  if (!prefsQuery.data) {
    return (
      <div data-testid="prefs-loading" className="rounded-[12px] border border-line bg-elev p-8 text-[12.5px] text-subtle">
        Loading your notification preferences&hellip;
      </div>
    );
  }

  const prefs = prefsQuery.data;
  const grouped = groupRows(prefs);

  function onToggle(type: string, channel: PrefChannel, enabled: boolean) {
    updatePref.mutate({ type, channel, enabled });
  }

  return (
    <div className="flex flex-col gap-5">
      {grouped.map(({ group, rows }) => (
        <GroupCard key={group.id} title={group.title}>
          {rows.map(({ type, byChannel }) => (
            <NotificationPrefRow
              key={type}
              type={type}
              byChannel={byChannel}
              pending={updatePref.isPending}
              onToggle={(channel, enabled) => onToggle(type, channel, enabled)}
            />
          ))}
        </GroupCard>
      ))}

      {/* Email digest group — a single deferred, email-only, off row (C-004). */}
      <GroupCard title="Email digest">
        <div className="border-t border-line">
          <DigestPrefRow />
        </div>
      </GroupCard>

      <div className="flex items-start gap-1.5 px-1 text-[11px] text-subtle">
        <Icon name="bell" size={13} />
        <span>Changes save automatically. Critical alerts you can&rsquo;t miss stay on.</span>
      </div>
    </div>
  );
}
