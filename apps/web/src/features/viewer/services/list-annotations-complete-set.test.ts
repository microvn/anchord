import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  fetchAllAnnotationPages,
  ANNOTATIONS_PAGE_LIMIT,
  type AnnotationPageGetter,
} from "@/features/viewer/services/paginate-annotations";

// AS-021 / C-008 (annotation-core-ui S-003): the viewer's annotation read must return the COMPLETE
// active annotation set for a doc, NOT a capped first page. The list endpoint paginates (default 20,
// cap 100); a single uncapped `.get()` therefore returns only the first 20 rows, silently dropping the
// tail from both the rail list and the in-text highlights. The read must request the max page size and
// follow `pagination.hasNext`, accumulating every page, so the rail total = the dashboard annotation
// count for the doc.
//
// We test the paging loop (fetchAllAnnotationPages) DIRECTLY with a fake page-getter. It lives in its
// own module (not client.ts), so it is NOT touched by the process-global `mock.module` shadow that the
// viewer component tests install on client.ts — this test stays deterministic in a full-suite run.

// The success envelope the real backend returns; the loop peels it per page (useApiQuery can't, since
// the loop consumes the body). Returning the enveloped shape proves the loop peels correctly.
const envelope = (items: unknown[], pagination?: unknown) => ({
  data: { success: true, data: { items, ...(pagination ? { pagination } : {}) }, timestamp: "t" },
  error: null,
});

function annotation(i: number) {
  return {
    id: `anno-${i}`,
    type: "range",
    status: "unresolved" as const,
    isOrphaned: false,
    anchor: { blockId: `block-${i}`, textSnippet: `snippet ${i}`, offset: 0, length: 5 },
    comments: [],
  };
}

// A 23-annotation doc — more than the endpoint's 20-row DEFAULT page (the dashboard reports 23).
const DEFAULT_PAGE = 20;
const TOTAL = 23;
const allAnnos = Array.from({ length: TOTAL }, (_, i) => annotation(i + 1));

// The fake SERVER caps its effective page at this many rows regardless of the requested limit, so the
// 23 annotations always span >1 page — forcing the loop to follow `hasNext`. (A real server caps at
// 100; a small cap keeps the fixture compact while still exercising the multi-page accumulation and
// proving no tail is dropped.)
const SERVER_PAGE_CAP = 10;

// Records each (page, limit) the loop requests, so we can assert it asked above the 20-row default.
let requested: Array<{ page: number; limit: number }> = [];

const getPage: AnnotationPageGetter = mock(async (page: number, limit: number) => {
  requested.push({ page, limit });
  const effective = Math.min(limit, SERVER_PAGE_CAP);
  const start = (page - 1) * effective;
  const slice = allAnnos.slice(start, start + effective);
  const totalPages = Math.ceil(TOTAL / effective);
  return envelope(slice, {
    page,
    limit: effective,
    total: TOTAL,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  });
});

describe("fetchAllAnnotationPages — complete active set, not a capped page (annotation-core-ui S-003)", () => {
  beforeEach(() => {
    (getPage as ReturnType<typeof mock>).mockClear();
    requested = [];
  });

  it("AS-021: the rail loads the COMPLETE active annotation set (23), not a capped first page", async () => {
    const res = await fetchAllAnnotationPages(getPage);
    expect(res.error).toBeNull();
    // Every one of the 23 active annotations comes back — no tail silently absent from the rail.
    expect(res.data?.items.length).toBe(TOTAL);
    expect(res.data?.items.map((a) => a.id)).toEqual(allAnnos.map((a) => a.id));
  });

  it("C-008: reads the full set by paging through hasNext, requesting the max page size (not the 20-row default)", async () => {
    const res = await fetchAllAnnotationPages(getPage);
    // It paged through every server page, never stopping at the first page.
    expect((getPage as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(1);
    // It asked for the cap (> the 20-row default) on every call, so one server page covers more rows.
    for (const q of requested) {
      expect(q.limit).toBe(ANNOTATIONS_PAGE_LIMIT);
      expect(q.limit).toBeGreaterThan(DEFAULT_PAGE);
    }
    // The rail total (item count) equals the server's reported total = the dashboard annotation count.
    expect(res.data?.items.length).toBe(res.data?.pagination?.total);
    expect(res.data?.pagination?.total).toBe(TOTAL);
  });

  it("C-008: a single non-paginated page (no hasNext) returns as-is — no extra request, no dropped rows", async () => {
    const oneFlatPage: AnnotationPageGetter = mock(async () =>
      // A reply with NO pagination block (a flat list) is one complete page.
      envelope(allAnnos.slice(0, 3)),
    );
    const res = await fetchAllAnnotationPages(oneFlatPage);
    expect((oneFlatPage as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect(res.data?.items.length).toBe(3);
  });

  it("AS-021: a no-access / error reply short-circuits verbatim (the viewer surfaces it in place)", async () => {
    const errored: AnnotationPageGetter = mock(async () => ({ data: null, error: { status: 404 } }));
    const res = await fetchAllAnnotationPages(errored);
    expect(res.error).toEqual({ status: 404 });
    expect(res.data).toBeNull();
    // It did not keep paging after the error.
    expect((errored as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});
