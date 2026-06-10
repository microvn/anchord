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
