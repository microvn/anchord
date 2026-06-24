// Wire types for the personal "Your actions" feed (your-activity-actions S-001).
//
// The cross-workspace own-actions read (`GET /api/me/activity`) serves rows in the SAME shape the
// workspace-activity feed components consume (ActivityEventRow) — plus the read-time `workspaceName`
// enrichment (AS-002), so the row carries its owning-workspace label. We REUSE ActivityEventRow
// (C-007 — no parallel row type) rather than mint a new one.

import type { ActivityEventRow } from "@/features/activity/types";

/** One "Your actions" row — the workspace feed's row shape, with workspaceName always present. */
export type MyActivityRow = ActivityEventRow & { workspaceName?: string | null };

/** The standard `{ items, pagination }` list payload the backend returns under the envelope. */
export interface MyActivityPage {
  items: MyActivityRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}
