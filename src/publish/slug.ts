// Slug generation for the publish flow (story S-001, C-004).
// A slug is derived from the title plus a short random suffix, generated ONCE at
// create time and never regenerated — it is the doc's immutable public identifier.

function slugifyTitle(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics (unicode titles stay readable)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "doc";
}

function randomSuffix(): string {
  // 6 base36 chars from crypto randomness — collision-resistant enough for a suffix.
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return n.toString(36).slice(0, 6).padStart(6, "0");
}

/** Generate an immutable slug from a title: `<slugified-title>-<suffix>` (C-004). */
export function generateSlug(title: string): string {
  return `${slugifyTitle(title)}-${randomSuffix()}`;
}
