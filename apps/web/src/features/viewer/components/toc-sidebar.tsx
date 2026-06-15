import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";

// TocSidebar (S-002): a collapsible outline derived from the rendered doc's headings (G6 — the FE
// derives the TOC from h1–h3, no backend outline payload; spec priority badges are dropped for v0).
// Clicking an entry scrolls its heading into view (AS-005); a scroll listener marks the in-view
// section active as the reader scrolls (AS-006, scroll-spy). The active-section math lives in the
// pure `pickActiveHeading` so it can be unit-tested without real layout (happy-dom does no layout).

export type Heading = { id: string; text: string; level: number };
type HeadingOffset = Heading & { offsetTop: number };

// Headings carry their id either as a real `id` (positional `block-{tag}-{n}` injected at serve
// time) or as `data-block-id` when the author already gave the element an id (block-id.ts never
// clobbers an existing id). Either makes the heading a jump target.
export function extractHeadings(root: ParentNode): Heading[] {
  const nodes = root.querySelectorAll<HTMLElement>("h1, h2, h3");
  const out: Heading[] = [];
  for (const el of nodes) {
    const id = el.id || el.getAttribute("data-block-id") || "";
    if (!id) continue; // no anchor → not a jump target, skip
    const text = (el.textContent ?? "").trim();
    if (!text) continue;
    out.push({ id, text, level: Number(el.tagName.slice(1)) });
  }
  return out;
}

// Pure scroll-spy core (AS-006): given each heading's offset within the scroll container and the
// container's current scrollTop (offset by a small threshold so a heading reads as "active" just
// before it reaches the very top), return the id of the last heading at/above that line — i.e. the
// section currently in view. Pure + layout-free so it is unit-testable under happy-dom.
export function pickActiveHeading(
  headings: readonly HeadingOffset[],
  scrollTop: number,
  threshold = 80,
): string | null {
  if (headings.length === 0) return null;
  const line = scrollTop + threshold;
  let active = headings[0]!.id;
  for (const h of headings) {
    if (h.offsetTop <= line) active = h.id;
    else break;
  }
  return active;
}

export function TocSidebar({
  contentEl,
  activeId,
  onActiveChange,
  onCollapse,
  className,
}: {
  // The rendered doc content element (the MarkdownView article / scroll container) to read
  // headings from and to scroll within. Null while the doc is still loading.
  contentEl: HTMLElement | null;
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  // AS-018: an in-pane collapse affordance beside the search input. The persistent top-bar
  // outline-toggle re-expands (it has to live outside the pane — collapsing removes this control
  // along with the pane). Omitted in contexts that don't collapse (none today).
  onCollapse?: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [headings, setHeadings] = useState<Heading[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const onActiveRef = useRef(onActiveChange);
  onActiveRef.current = onActiveChange;

  // Re-derive the outline whenever the content element changes (a new doc rendered) AND whenever
  // the content *inside* it changes. The viewer's <main> scroll container mounts empty (skeleton)
  // and keeps the same element identity when the doc swaps in after the query resolves, so a
  // dependency on `contentEl` identity alone never re-runs. A MutationObserver on the subtree
  // catches the late-arriving headings. We still extract once immediately for the synchronous case.
  useEffect(() => {
    if (!contentEl) {
      setHeadings([]);
      return;
    }
    const apply = () =>
      setHeadings((prev) => {
        const next = extractHeadings(contentEl);
        // Skip the state update (and its re-render) when the outline is unchanged — the observer
        // fires on every subtree mutation during render, but the heading set rarely changes.
        return sameHeadings(prev, next) ? prev : next;
      });
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(contentEl, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [contentEl]);

  // Scroll-spy: find the scroll container, recompute the active heading on scroll. We resolve each
  // heading's offset against the container at scroll time (layout may shift), feed the pure picker.
  useEffect(() => {
    if (!contentEl || headings.length === 0) return;
    const scroller = findScroller(contentEl);
    const compute = () => {
      const withOffsets: HeadingOffset[] = headings.map((h) => {
        const el = contentEl.querySelector<HTMLElement>(byId(h.id));
        return { ...h, offsetTop: el ? offsetWithin(el, scroller) : 0 };
      });
      onActiveRef.current(pickActiveHeading(withOffsets, scroller.scrollTop));
    };
    compute();
    scroller.addEventListener("scroll", compute, { passive: true });
    return () => scroller.removeEventListener("scroll", compute);
  }, [contentEl, headings]);

  // Keep the active entry visible as scroll-spy advances it: scroll the outline list (NOT the
  // page) so the current section's item stays in view while the reader scrolls the content.
  // `block: "nearest"` only nudges the nearest scroll container (this list, a separate subtree
  // from the doc scroller) and is a no-op when the item is already visible.
  useEffect(() => {
    if (!activeId) return;
    const el = listRef.current?.querySelector<HTMLElement>('a[aria-current="location"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return headings;
    return headings.filter((h) => h.text.toLowerCase().includes(q));
  }, [headings, query]);

  const jump = (id: string) => {
    const el = contentEl?.querySelector<HTMLElement>(byId(id));
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    onActiveRef.current(id);
  };

  return (
    <nav
      data-testid="toc-sidebar"
      aria-label="Document outline"
      className={`flex h-full min-h-0 flex-col ${className ?? ""}`}
    >
      <div className="flex h-11 flex-none items-center gap-2 border-b border-line px-3">
        <Icon name="search" size={14} className="flex-none text-subtle" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter outline…"
          className="w-full border-none bg-transparent text-[12.5px] text-ink outline-none placeholder:text-subtle"
        />
        {onCollapse && (
          <button
            type="button"
            aria-label="Collapse outline"
            title="Collapse outline"
            onClick={onCollapse}
            className="inline-flex size-6 flex-none items-center justify-center rounded-[6px] text-subtle transition-colors hover:bg-elev hover:text-ink"
          >
            <Icon name="chevLeft" size={16} />
          </button>
        )}
      </div>
      <ul ref={listRef} className="min-h-0 flex-1 overflow-auto px-2 py-2">
        {filtered.map((h) => {
          const active = h.id === activeId;
          return (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  jump(h.id);
                }}
                aria-current={active ? "location" : undefined}
                className={`block truncate rounded-md py-1.5 text-[12.5px] leading-snug transition-colors ${
                  active
                    ? "bg-accent-soft font-medium text-accent-ink"
                    : "text-subtle hover:text-ink"
                }`}
                style={{ paddingLeft: 8 + (h.level - 1) * 12, paddingRight: 8 }}
              >
                {h.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// Shallow value-equality for two heading lists, so the MutationObserver can skip a redundant
// setState (and re-render) when a subtree mutation didn't actually change the outline.
function sameHeadings(a: readonly Heading[], b: readonly Heading[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.text !== y.text || x.level !== y.level) return false;
  }
  return true;
}

// A CSS-escaped `#id` selector so an id with odd chars can't break querySelector.
function byId(id: string): string {
  const cssEscape = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
  return `#${cssEscape ? cssEscape(id) : id.replace(/[^\w-]/g, "\\$&")}`;
}

// Walk up to the nearest scrollable ancestor (overflow auto/scroll); fall back to the content's
// document scrolling element. This is the element whose scrollTop the scroll-spy reads.
function findScroller(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el;
  while (node && node !== document.body) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

// A heading's top relative to the scroll container (so it can be compared to scrollTop).
function offsetWithin(el: HTMLElement, scroller: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}
