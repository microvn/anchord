import { describe, it, expect } from "bun:test";
import {
  applyDocFilter,
  statusCounts,
  formatCounts,
  accessCounts,
  updatedCounts,
  isFilterActive,
  sortDocs,
  ALL_STATUS,
  ALL_FORMAT,
  ALL_ACCESS,
  type StatusFacet,
  type FormatFacet,
  type AccessFacet,
} from "@/features/docs/lib/doc-filter";
import type { DocRow } from "@/features/docs/types";

// workspace-project-browse S-002 — the faceted filter engine (pure logic). Mirrors the rail engine:
// OR within an axis, AND across axes (C-003); dynamic counts vs the other axes (C-004); single-select
// Updated window. now = a fixed epoch so the recency math is deterministic.

const NOW = Date.parse("2026-06-19T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function doc(p: Partial<DocRow> & { id: string }): DocRow {
  return {
    slug: p.id,
    title: p.title ?? p.id,
    kind: "markdown",
    version: 1,
    annotationCount: 0,
    authorName: "Me",
    status: "live",
    generalAccess: "anyone_in_workspace",
    updatedAt: daysAgo(1),
    createdAt: daysAgo(1),
    ...p,
  };
}

// A small mixed set: statuses, formats, access, recency all vary.
const DOCS: DocRow[] = [
  doc({ id: "a", status: "live", kind: "html", generalAccess: "restricted", updatedAt: daysAgo(1) }),
  doc({ id: "b", status: "draft", kind: "markdown", generalAccess: "restricted", updatedAt: daysAgo(3) }),
  doc({ id: "c", status: "live", kind: "image", generalAccess: "anyone_in_workspace", updatedAt: daysAgo(10) }),
  doc({ id: "d", status: "live", kind: "markdown", generalAccess: "anyone_with_link", updatedAt: daysAgo(20) }),
  doc({ id: "e", status: "draft", kind: "html", generalAccess: "anyone_with_link", updatedAt: daysAgo(40) }),
];

const all = {
  s: ALL_STATUS,
  f: ALL_FORMAT,
  a: ALL_ACCESS,
};

describe("doc-filter — predicate (C-003: OR within axis, AND across axes)", () => {
  it("AS-005: everything selected + Updated=any shows every doc", () => {
    const out = applyDocFilter(DOCS, all.s, all.f, all.a, "any", NOW);
    expect(out.map((d) => d.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("AS-006: deselecting a Format value drops docs of that format", () => {
    const noMarkdown = new Set<FormatFacet>(["html", "image"]);
    const out = applyDocFilter(DOCS, all.s, noMarkdown, all.a, "any", NOW);
    // b and d are markdown → gone.
    expect(out.map((d) => d.id)).toEqual(["a", "c", "e"]);
  });

  it("AS-007: facets AND across axes — Draft AND Restricted shows only b", () => {
    const onlyDraft = new Set<StatusFacet>(["draft"]);
    const onlyRestricted = new Set<AccessFacet>(["restricted"]);
    const out = applyDocFilter(DOCS, onlyDraft, all.f, onlyRestricted, "any", NOW);
    expect(out.map((d) => d.id)).toEqual(["b"]);
  });

  it("AS-008: the Updated window narrows by recency (single choice)", () => {
    // 7d → updated within 7 days: a (1), b (3). 30d → a, b, c (10), d (20).
    expect(applyDocFilter(DOCS, all.s, all.f, all.a, "7d", NOW).map((d) => d.id)).toEqual(["a", "b"]);
    expect(applyDocFilter(DOCS, all.s, all.f, all.a, "30d", NOW).map((d) => d.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("an empty multi axis matches nothing", () => {
    expect(applyDocFilter(DOCS, new Set(), all.f, all.a, "any", NOW)).toHaveLength(0);
  });
});

describe("doc-filter — dynamic counts (C-004)", () => {
  it("AS-005: with everything selected, each value's count is its whole-browse total", () => {
    const sc = statusCounts(DOCS, all.f, all.a, "any", NOW);
    expect(sc).toEqual({ live: 3, draft: 2 });
    const fc = formatCounts(DOCS, all.s, all.a, "any", NOW);
    expect(fc).toEqual({ html: 2, markdown: 2, image: 1 });
    const ac = accessCounts(DOCS, all.s, all.f, "any", NOW);
    expect(ac).toEqual({ restricted: 2, anyone_in_workspace: 1, anyone_with_link: 2 });
  });

  it("AS-009: counts are dynamic against the other axes — narrowing Access to Link recomputes Status/Format", () => {
    const onlyLink = new Set<AccessFacet>(["anyone_with_link"]);
    // Link docs: d (live, markdown), e (draft, html).
    expect(statusCounts(DOCS, all.f, onlyLink, "any", NOW)).toEqual({ live: 1, draft: 1 });
    expect(formatCounts(DOCS, all.s, onlyLink, "any", NOW)).toEqual({ html: 1, markdown: 1, image: 0 });
  });

  it("AS-008: updated-window counts nest (7d ⊆ 30d ⊆ any)", () => {
    expect(updatedCounts(DOCS, all.s, all.f, all.a, NOW)).toEqual({ any: 5, "7d": 2, "30d": 4 });
  });
});

describe("doc-filter — sort (C-007: Updated/Created desc, Title asc)", () => {
  // Distinct created vs updated orderings so a wrong key is caught.
  const SORT_DOCS: DocRow[] = [
    doc({ id: "webhook", title: "Webhook", createdAt: daysAgo(2), updatedAt: daysAgo(30) }),
    doc({ id: "auth", title: "Auth", createdAt: daysAgo(30), updatedAt: daysAgo(1) }),
    doc({ id: "calendar", title: "Calendar", createdAt: daysAgo(10), updatedAt: daysAgo(10) }),
  ];

  it("AS-012: Updated orders most-recently-updated first (the default key)", () => {
    // updated: auth(1) < calendar(10) < webhook(30) ago → auth, calendar, webhook.
    expect(sortDocs(SORT_DOCS, "updated").map((d) => d.id)).toEqual(["auth", "calendar", "webhook"]);
  });

  it("AS-014: Created orders by creation time, newest first", () => {
    // created: webhook(2) < calendar(10) < auth(30) ago → webhook, calendar, auth.
    expect(sortDocs(SORT_DOCS, "created").map((d) => d.id)).toEqual(["webhook", "calendar", "auth"]);
  });

  it("AS-013: Title orders alphabetically A→Z", () => {
    expect(sortDocs(SORT_DOCS, "title").map((d) => d.id)).toEqual(["auth", "calendar", "webhook"]);
  });

  it("a row missing the timestamp sorts last under Updated/Created", () => {
    const withMissing: DocRow[] = [doc({ id: "dated", updatedAt: daysAgo(5) }), doc({ id: "undated", updatedAt: undefined })];
    expect(sortDocs(withMissing, "updated").map((d) => d.id)).toEqual(["dated", "undated"]);
  });
});

describe("doc-filter — active state (C-004)", () => {
  it("AS-010: all selected + Updated=any → inactive; any value off or narrower window → active", () => {
    expect(isFilterActive(all.s, all.f, all.a, "any")).toBe(false);
    expect(isFilterActive(new Set<StatusFacet>(["live"]), all.f, all.a, "any")).toBe(true);
    expect(isFilterActive(all.s, all.f, all.a, "7d")).toBe(true);
  });
});
