import { peelEnvelope, type EdenResult } from "@/lib/api/use-api-query";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// annotation-core-ui S-003 / AS-021 / C-008 — the COMPLETE-SET annotation read loop.
//
// The list endpoint paginates (default 20 rows, cap 100). The viewer must read the ENTIRE active
// annotation set for a doc on open, never a capped first page: every active annotation gets a rail
// thread and (when placeable) an in-text highlight, and the rail total equals the dashboard's
// annotation count for the doc. So this loop requests the max page size and follows
// `pagination.hasNext`, accumulating every page.
//
// This lives in its OWN module (not client.ts) on purpose: client.ts is `mock.module`-shadowed by
// ~18 viewer component tests (bun's mock.module is process-global), which would make a service-level
// test of the loop nondeterministic. Keeping the pure loop here lets it be unit-tested directly with
// a fake page-getter, untouched by those component mocks.

export interface AnnotationsPage {
  items: ViewerAnnotation[];
  pagination?: { page: number; limit: number; total: number; hasNext?: boolean; totalPages?: number };
}

/** The per-page size requested. The endpoint clamps to its cap (100); the viewer must not inherit the
 *  20-row default, so it asks for the cap and pages through `hasNext`. */
export const ANNOTATIONS_PAGE_LIMIT = 100;
/** Safety bound on the page count so a misbehaving server that always reports `hasNext` can't loop
 *  forever. 100 pages × 100 rows = 10k annotations, far past any realistic doc. */
export const ANNOTATIONS_MAX_PAGES = 100;

/** Fetches one page (1-based) at the given limit and resolves to the RAW treaty result (the success
 *  envelope or an `{ data, error }` failure). */
export type AnnotationPageGetter = (
  page: number,
  limit: number,
) => Promise<EdenResult<unknown>>;

/**
 * Read the COMPLETE active annotation set by paging through `hasNext` (AS-021 / C-008).
 *
 * - Requests {@link ANNOTATIONS_PAGE_LIMIT} per page; accumulates every page's items.
 * - The first error (no-access / transport) short-circuits and is returned VERBATIM, so the viewer's
 *   in-place error handling (AS-014) is unchanged from a single-call read.
 * - A reply with no `pagination` block (a flat list) is treated as one complete page.
 * - The returned payload is already envelope-peeled, so `useApiQuery`'s peel is a no-op on it.
 */
export async function fetchAllAnnotationPages(
  getPage: AnnotationPageGetter,
): Promise<EdenResult<AnnotationsPage>> {
  const all: ViewerAnnotation[] = [];
  let lastPagination: AnnotationsPage["pagination"];

  for (let page = 1; page <= ANNOTATIONS_MAX_PAGES; page += 1) {
    const result = await getPage(page, ANNOTATIONS_PAGE_LIMIT);

    if (result.error || result.data == null) {
      return result as EdenResult<AnnotationsPage>;
    }

    // The raw treaty body is the success envelope `{ success, data: { items, pagination } }`; peel
    // the one envelope layer here (the loop consumes the body, so it can't defer the peel to
    // useApiQuery the way a single-call thunk did). A flat/mock payload passes through untouched.
    const payload = peelEnvelope(result.data) as AnnotationsPage;
    all.push(...(payload.items ?? []));
    lastPagination = payload.pagination;
    // No pagination block, or the server says there's no next page → we have the complete set.
    if (!lastPagination?.hasNext) break;
  }

  return {
    data: {
      items: all,
      ...(lastPagination
        ? { pagination: { ...lastPagination, total: lastPagination.total ?? all.length } }
        : {}),
    },
    error: null,
  };
}
