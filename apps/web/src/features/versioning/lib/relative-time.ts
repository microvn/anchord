// Compact relative time for the version timeline (prototype `.vh-time`, e.g. "2h ago", "3d ago").
// No shared relative-time helper exists in @/lib yet, so this small feature-local one covers the
// timeline's need. Deterministic: takes an explicit `now` so tests don't depend on the wall clock.
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((now.getTime() - then) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return "just now";
  const mins = Math.round(diffSec / 60);
  if (Math.abs(mins) < 60) return `${Math.abs(mins)}m ago`;
  const hours = Math.round(diffSec / 3600);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)}h ago`;
  const days = Math.round(diffSec / 86400);
  if (Math.abs(days) < 30) return `${Math.abs(days)}d ago`;
  const months = Math.round(diffSec / (86400 * 30));
  if (Math.abs(months) < 12) return `${Math.abs(months)}mo ago`;
  const years = Math.round(diffSec / (86400 * 365));
  return `${Math.abs(years)}y ago`;
}
