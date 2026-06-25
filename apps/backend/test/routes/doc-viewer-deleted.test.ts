// doc-delete-trash S-004 — route-level tests for the GATED deleted notice on the
// DOC-ADDRESSED viewer route (GET /api/docs/:slug), exercising the REAL
// `createLoadViewerDoc` loader over a fake db + an injected `resolveAccess`.
//
// What is under test here is the loader→route mapping the spec calls for:
//   · a viewer who WOULD HAVE had access to a now-deleted doc (resolveAccess returns the
//     `deleted` reason) → the route responds 410 DOC_DELETED, NEVER the doc content. The FE
//     maps that code to NoAccessView variant="deleted" (AS-014).
//   · a viewer with NO prior access (resolveAccess returns plain DENIED, no reason) → the
//     standard existence-hiding 404 NOT_FOUND, byte-identical to a missing slug (AS-015).
//
// The resolveAccess DECISION itself (when the reason is/ isn't set) is proven exhaustively
// in src/sharing/resolve-access.test.ts; here we prove the loader + HTTP glue honour it.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { createLoadViewerDoc } from "../../src/render/viewer-loaders";
import type { DB } from "../../src/db/client";
import type { Viewer } from "../../src/sharing/access";
import type { AccessResult } from "../../src/sharing/resolve-access";
import { docVersions } from "../../src/db/schema";

/**
 * Minimal Drizzle fake for the loader's two reads:
 *   1. select().from(docs).leftJoin(shareLinks).where().limit(1) → the doc+axes row
 *   2. select().from(docVersions).where().orderBy().limit(1)     → the current version row
 * A thenable that also exposes leftJoin/where/orderBy/limit, all returning the seeded rows.
 */
function fakeDb(seed: {
  docRow?: Record<string, unknown> | null;
  versionRow?: Record<string, unknown> | null;
}): DB {
  return {
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === docVersions
              ? seed.versionRow
                ? [seed.versionRow]
                : []
              : seed.docRow
                ? [seed.docRow]
                : [];
          const chain: any = Promise.resolve(rows);
          chain.leftJoin = () => chain;
          chain.where = () => chain;
          chain.orderBy = () => chain;
          chain.limit = () => Promise.resolve(rows);
          return chain;
        },
      };
    },
  } as unknown as DB;
}

const DELETED_DOC = {
  id: "doc_1",
  title: "Spec v1",
  kind: "markdown" as const,
  workspaceRole: null,
  linkRole: null,
};
const VERSION = { id: "ver_1", version: 2, content: "# Spec v1\n\nsecret body" };

/** Build the app's doc-addressed route with the real loader + an injected resolveAccess. */
function buildApp(access: AccessResult) {
  const db = fakeDb({ docRow: DELETED_DOC, versionRow: VERSION });
  const resolveAccess = async (_docId: string, _viewer: Viewer): Promise<AccessResult> => access;
  const loadViewerDoc = createLoadViewerDoc({ db, resolveAccess });
  return createApp({
    dbCheck: async () => {},
    docViewer: { resolveViewerSession: async () => ({ userId: "u_reader" }), loadViewerDoc },
  });
}

function get(slug: string) {
  return new Request(`http://localhost/api/docs/${slug}`);
}

describe("GET /api/docs/:slug — gated deleted notice (S-004)", () => {
  test("AS-014: a viewer who HAD access to a now-deleted doc → 410 DOC_DELETED, content NOT rendered", async () => {
    // resolveAccess surfaces the `deleted` reason (prior-access viewer) → the loader throws
    // DocDeletedError → the envelope responds 410 with code DOC_DELETED. The FE renders the
    // "deleted" NoAccessView. The doc's body must NEVER appear in the response.
    const app = buildApp({ role: null, canView: false, reason: "deleted" });
    const res = await app.handle(get("spec-v1"));

    expect(res.status).toBe(410);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("DOC_DELETED");
    // Content-hiding: neither the rendered body nor the title leaks into the notice response.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("secret body");
    expect(raw).not.toContain("Spec v1");
  });

  test("AS-015: a viewer with NO prior access to a deleted doc → 404 NOT_FOUND, byte-identical to a missing slug", async () => {
    // resolveAccess returns the PLAIN denied result (no `deleted` reason) for a no-prior-access
    // viewer → the loader returns null → the route's existence-hiding 404. The deleted notice is
    // never shown (no enumeration oracle), and the body is identical to a truly-missing doc.
    const noAccess = await buildApp({ role: null, canView: false }).handle(get("spec-v1"));
    // A genuinely missing doc: same route, resolveAccess never even matters because the doc row
    // is absent → null → 404. (Models the "never existed" slug.)
    const dbMissing = fakeDb({ docRow: null, versionRow: null });
    const missingApp = createApp({
      dbCheck: async () => {},
      docViewer: {
        resolveViewerSession: async () => ({ userId: "u_reader" }),
        loadViewerDoc: createLoadViewerDoc({
          db: dbMissing,
          resolveAccess: async () => ({ role: null, canView: false }),
        }),
      },
    });
    const missing = await missingApp.handle(get("never-existed"));

    expect(noAccess.status).toBe(404);
    expect(missing.status).toBe(404);
    const noAccessJson = (await noAccess.json()) as any;
    const missingJson = (await missing.json()) as any;
    expect(noAccessJson.error.code).toBe("NOT_FOUND");
    expect(missingJson.error.code).toBe("NOT_FOUND");
    // Existence-hiding: byte-identical error shapes (strip per-request jitter + the path, which
    // legitimately differs by slug and is not access-revealing).
    const strip = (j: any) => ({ ...j, timestamp: "T", requestId: "R", path: "P" });
    expect(strip(noAccessJson)).toEqual(strip(missingJson));
    // And the no-access response carries no hint that the doc was deleted (no oracle).
    expect(JSON.stringify(noAccessJson)).not.toContain("DOC_DELETED");
  });
});
