// Avatar initials from a display name or email (Anchord-Design `initials()`): first letters of
// the first two words, else the first two characters of the local-part. Always uppercase,
// 1–2 chars. Falls back to "?" when there's nothing usable.
export function initials(nameOrEmail: string | null | undefined): string {
  const raw = (nameOrEmail ?? "").trim();
  if (!raw) return "?";
  const base = raw.includes("@") ? raw.split("@")[0]! : raw;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

// Deterministic avatar background (Anchord-Design `avatarColor()`): a stable hash over the
// name picks one of six fixed teal/earth tones, so the same person always gets the same circle.
const AVATAR_COLORS = ["#0b6b73", "#3a6ea5", "#7a5a9e", "#a85d3e", "#3f7a52", "#9a6700"];
export function avatarColor(nameOrEmail: string | null | undefined): string {
  const raw = (nameOrEmail ?? "").trim() || "?";
  let h = 0;
  for (const c of raw) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}
