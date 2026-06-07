// Block-id injection (annotation-core S-001, C-001). At serve/publish time the app
// walks the block-level elements of a rendered doc in DOM order and stamps each with
// a POSITIONAL id `block-{tag}-{n}` — a per-tag sequential counter (so the first <p>
// is block-p-1, the second block-p-2, the first <li> is block-li-1, …).
//
// This id is a HINT, not a durable key (C-001): an annotation anchors by block_id
// PLUS text_snippet+offset, and durability across versions rides on the snippet +
// fuzzy match + orphan fallback (C-002, S-005). The id's only job here is to
// disambiguate a duplicate snippet that appears in two different blocks (AS-003):
// the same phrase in block-p-3 vs block-p-9 anchors to whichever block the user
// actually selected, by id.
//
// Don't-clobber rule (C-001): an element that ALREADY carries an `id` keeps it; we
// attach `data-block-id="block-{tag}-{n}"` instead, so we never break the author's
// own anchors / CSS / scripts while still giving every block an addressable handle.
//
// Pure string→string transform, deterministic, no DOM library — a minimal,
// purpose-built tokenizer over the opening tags of the block elements we care about.
// (markdown-it/DOMPurify produce a known, normalized tag set, so a full HTML parser
// is overkill here; this stays portable and trivially unit-testable.)

/** Block-level tags that get a positional id. Inline tags (span/a/strong/…) do not. */
const BLOCK_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "table",
  "tr",
  "td",
  "th",
  "ul",
  "ol",
  "div",
  "section",
  "article",
  "figure",
] as const;

const BLOCK_TAG_SET = new Set<string>(BLOCK_TAGS);

/**
 * Whether an opening tag already declares an `id="…"` attribute. If so we must not
 * clobber it (C-001) — we add `data-block-id` instead.
 */
function hasIdAttr(openTag: string): boolean {
  return /\sid\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.test(openTag);
}

/**
 * Stamp every block-level element with a positional `block-{tag}-{n}` id (per-tag
 * sequential counter, DOM order). An element that already has an `id` gets a
 * `data-block-id` instead (don't clobber). Self-closing/void tags are not block
 * elements here, so they're left untouched.
 *
 * The transform is idempotent-safe in the sense that it only ever ADDS an attribute;
 * it never rewrites an existing id. Returns the HTML unchanged if there are no block
 * elements.
 */
export function injectBlockIds(html: string): string {
  const counters = new Map<string, number>();

  // Match an opening tag: `<tag …>`. We deliberately ignore close tags (`</tag>`),
  // comments, and the doc body text — only the opening tag of a block gets stamped.
  return html.replace(/<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g, (full, rawTag: string, attrs: string, selfClose: string) => {
    const tag = rawTag.toLowerCase();
    if (!BLOCK_TAG_SET.has(tag)) return full; // inline / non-block tag: leave as-is
    if (selfClose === "/") return full; // self-closing: not a container block

    const n = (counters.get(tag) ?? 0) + 1;
    counters.set(tag, n);
    const blockId = `block-${tag}-${n}`;

    const openTag = `<${rawTag}${attrs}>`;
    const attr = hasIdAttr(openTag)
      ? ` data-block-id="${blockId}"` // C-001: don't clobber an existing id
      : ` id="${blockId}"`;

    // Insert the attribute right after the tag name (before any existing attrs),
    // preserving everything else verbatim.
    return `<${rawTag}${attr}${attrs}${selfClose}>`;
  });
}
