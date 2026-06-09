// In-process route tests for the workspace-project S-005 /api/search mount (no DB).
// HTTP GLUE only — envelope + auth gate + Zod (q required / projectId uuid) + the
// service over a FAKE SearchRepo. The real-Postgres FTS + SQL access filter is covered
// by test/integration/search.itest.ts.
//
// The fake repo SIMULATES the repo's SQL access filter: it only ever returns rows the
// searcher can access, exactly as the production query does. The route test asserts
// the existence-hiding contract end to end — an out-of-access doc's bytes appear
// NOWHERE in the response (C-003 / AS-009).

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SearchHit, SearchQuery, SearchRepo } from "../../src/search/search-repo";
import type { SessionResolver } from "../../src/http/auth-gate";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

/**
 * A fake repo modelling the production query: it holds docs with an access predicate
 * and returns ONLY the ones the searcher can access (existence-hiding by construction,
 * like the SQL). `accessibleTo` decides who may see each doc.
 */
function fakeRepo(
  docs: Array<{
    hit: SearchHit;
    matchesQuery: (q: string) => boolean;
    accessibleTo: (userId: string) => boolean;
    projectId?: string;
  }>,
): SearchRepo {
  return {
    async search(q: SearchQuery): Promise<SearchHit[]> {
      return docs
        .filter(
          (d) =>
            d.matchesQuery(q.text) &&
            d.accessibleTo(q.userId) &&
            (q.projectId === undefined || d.projectId === q.projectId),
        )
        .map((d) => d.hit)
        .slice(0, q.limit);
    },
  };
}

function buildApp(resolveSession: SessionResolver, repo: SearchRepo) {
  return createApp({ dbCheck: async () => {}, search: { repo, resolveSession, resolveWorkspaceRole: async () => "member" } });
}

function req(path: string) {
  return new Request(`http://localhost${path}`, {
    method: "GET",
    headers: { "content-type": "application/json" },
  });
}

const mkHit = (docId: string, title: string, source: SearchHit["matchSource"]): SearchHit => ({
  docId,
  slug: docId,
  title,
  kind: "markdown",
  matchSource: source,
});

describe("/api/search route glue (workspace-project S-005)", () => {
  test("AS-009/C-003: returns the accessible match, OMITS the out-of-access doc (existence-hiding)", async () => {
    const repo = fakeRepo([
      {
        hit: mkHit("d_pay", "Payment Spec", "content"),
        matchesQuery: (q) => q.includes("refund"),
        accessibleTo: (u) => u === "u_x", // owner/invited
      },
      {
        // restricted doc that ALSO matches "refund" (via a comment), but u_x can't access.
        hit: mkHit("d_secret", "Secret Refund Memo", "comment"),
        matchesQuery: (q) => q.includes("refund"),
        accessibleTo: () => false,
      },
    ]);
    const app = buildApp(asUser("u_x"), repo);
    const res = await app.handle(req("/api/w/ws_1/search?q=refund"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.results.map((r: any) => r.docId)).toEqual(["d_pay"]);
    // existence-hiding: NO byte of the out-of-access doc leaks.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("d_secret");
    expect(raw).not.toContain("Secret Refund Memo");
  });

  test("AS-010: project scope filters to the scoped project's docs", async () => {
    const PID = "13359f74-bbe5-4c32-bc43-017fb5b3992a";
    const repo = fakeRepo([
      {
        hit: mkHit("d_bill", "Billing Invoice", "title"),
        matchesQuery: (q) => q.includes("invoice"),
        accessibleTo: () => true,
        projectId: PID,
      },
      {
        hit: mkHit("d_other", "Other Invoice", "title"),
        matchesQuery: (q) => q.includes("invoice"),
        accessibleTo: () => true,
        projectId: "139ef255-6d78-446b-b2d6-20f7367d955d",
      },
    ]);
    const app = buildApp(asUser("u_x"), repo);
    const res = await app.handle(req(`/api/w/ws_1/search?q=invoice&projectId=${PID}`));
    const json = (await res.json()) as any;
    expect(json.data.results.map((r: any) => r.docId)).toEqual(["d_bill"]);
  });

  test("empty q → 400 VALIDATION_ERROR", async () => {
    const app = buildApp(asUser("u_x"), fakeRepo([]));
    const res = await app.handle(req("/api/w/ws_1/search?q="));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  test("whitespace-only q → 400 (service parseQuery rejects)", async () => {
    const app = buildApp(asUser("u_x"), fakeRepo([]));
    const res = await app.handle(req("/api/w/ws_1/search?q=%20%20"));
    expect(res.status).toBe(400);
  });

  test("invalid projectId (not a uuid) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp(asUser("u_x"), fakeRepo([]));
    const res = await app.handle(req("/api/w/ws_1/search?q=x&projectId=not-a-uuid"));
    expect(res.status).toBe(400);
  });

  test("no session → 401 (handler never runs)", async () => {
    let touched = false;
    const repo: SearchRepo = {
      async search() {
        touched = true;
        return [];
      },
    };
    const app = buildApp(noSession, repo);
    const res = await app.handle(req("/api/w/ws_1/search?q=refund"));
    expect(res.status).toBe(401);
    expect(touched).toBe(false);
  });

  test("identity is the SESSION actor, not a query field", async () => {
    let seenUser: string | undefined;
    const repo: SearchRepo = {
      async search(q) {
        seenUser = q.userId;
        return [];
      },
    };
    const app = buildApp(asUser("u_real"), repo);
    // a forged userId in the query must be ignored.
    await app.handle(req("/api/w/ws_1/search?q=x&userId=u_attacker"));
    expect(seenUser).toBe("u_real");
  });
});
