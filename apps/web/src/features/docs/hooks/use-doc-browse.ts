import { useMemo, useState } from "react";
import type { DocRow } from "@/features/docs/types";
import {
  ALL_STATUS,
  ALL_FORMAT,
  ALL_ACCESS,
  type StatusFacet,
  type FormatFacet,
  type AccessFacet,
  type UpdatedWindow,
  type SortKey,
  applyDocFilter,
  sortDocs,
  statusCounts,
  formatCounts,
  accessCounts,
  updatedCounts,
  isFilterActive,
} from "@/features/docs/lib/doc-filter";

// useDocBrowse (workspace-project-browse S-002 + S-003): the shared filter+sort+view state for BOTH
// browse surfaces (All-docs DocsScreen and the per-project ProjectDocsScreen) — C-005. Owns the four
// facet selections, the sort key, and the grid/list view; computes the visible (filtered THEN sorted)
// doc list, the dynamic facet counts (C-004), and the filter-active flag. `now` is injectable so the
// recency window is testable; defaults to the wall clock.

function toggle<T>(set: ReadonlySet<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
}

export interface DocFilterState {
  status: ReadonlySet<StatusFacet>;
  format: ReadonlySet<FormatFacet>;
  access: ReadonlySet<AccessFacet>;
  updated: UpdatedWindow;
  counts: {
    status: Record<StatusFacet, number>;
    format: Record<FormatFacet, number>;
    access: Record<AccessFacet, number>;
    updated: Record<UpdatedWindow, number>;
  };
  active: boolean;
  toggleStatus: (f: StatusFacet) => void;
  toggleFormat: (f: FormatFacet) => void;
  toggleAccess: (f: AccessFacet) => void;
  setUpdated: (w: UpdatedWindow) => void;
  reset: () => void;
}

export interface DocBrowse {
  /** The docs to render — filtered, then sorted. */
  visible: DocRow[];
  /** The unfiltered doc count (the "of N" in "showing X of N"). */
  total: number;
  view: "grid" | "list";
  setView: (v: "grid" | "list") => void;
  sort: SortKey;
  setSort: (k: SortKey) => void;
  filter: DocFilterState;
}

export function useDocBrowse(docs: DocRow[], now: number = Date.now()): DocBrowse {
  const [status, setStatus] = useState<ReadonlySet<StatusFacet>>(ALL_STATUS);
  const [format, setFormat] = useState<ReadonlySet<FormatFacet>>(ALL_FORMAT);
  const [access, setAccess] = useState<ReadonlySet<AccessFacet>>(ALL_ACCESS);
  const [updated, setUpdated] = useState<UpdatedWindow>("any");
  const [sort, setSort] = useState<SortKey>("updated");
  const [view, setView] = useState<"grid" | "list">("grid");

  const visible = useMemo(
    () => sortDocs(applyDocFilter(docs, status, format, access, updated, now), sort),
    [docs, status, format, access, updated, sort, now],
  );

  const counts = useMemo(
    () => ({
      status: statusCounts(docs, format, access, updated, now),
      format: formatCounts(docs, status, access, updated, now),
      access: accessCounts(docs, status, format, updated, now),
      updated: updatedCounts(docs, status, format, access, now),
    }),
    [docs, status, format, access, updated, now],
  );

  return {
    visible,
    total: docs.length,
    view,
    setView,
    sort,
    setSort,
    filter: {
      status,
      format,
      access,
      updated,
      counts,
      active: isFilterActive(status, format, access, updated),
      toggleStatus: (f) => setStatus((s) => toggle(s, f)),
      toggleFormat: (f) => setFormat((s) => toggle(s, f)),
      toggleAccess: (f) => setAccess((s) => toggle(s, f)),
      setUpdated,
      reset: () => {
        setStatus(ALL_STATUS);
        setFormat(ALL_FORMAT);
        setAccess(ALL_ACCESS);
        setUpdated("any");
      },
    },
  };
}
