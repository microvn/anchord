// Unit tests for the search service (workspace-project S-005). Drives the query
// parse, the defense-in-depth access re-check (canBrowseDoc — the SAME browse+search
// rule from S-003), the cap+log, and the result shape with a FAKE repo (no DB, no FTS).
//
// The repo's SQL access filter is integration-verified separately; here we prove the
// SERVICE layer drops an out-of-access hit — including a doc surfaced via a COMMENT
// match (C-003 / H2) — and rejects an empty query.

import { describe, expect, test } from "bun:test";
import {
  search,
  parseQuery,
  SearchRejected,
  SEARCH_RESULT_CAP,
  type SearchDeps,
  type SearchAccessDeps,
} from "./search";
import type { GeneralAccessLevel } from "../sharing/access";
import type { SearchHit, SearchQuery, SearchRepo } from "./search-repo";

function fakeRepo(hits: SearchHit[], onQuery?: (q: SearchQuery) => void): SearchRepo {
  return {
    async search(q) {
      onQuery?.(q);
      return hits;
    },
  };
}

/** Access deps built from a static map of doc → {ownerId, generalAccess} + membership. */
function fakeAccess(opts: {
  fields: Record<string, { ownerId: string | null; generalAccess: GeneralAccessLevel }>;
  invited?: Set<string>; // `${docId}:${userId}`
  members?: Set<string>;
}): SearchAccessDeps {
  return {
    accessFieldsFor: (docId) => opts.fields[docId] ?? { ownerId: null, generalAccess: "restricted" },
    isInvited: (docId, userId) => !!opts.invited?.has(`${docId}:${userId}`),
    isWorkspaceMember: (userId) => !!opts.members?.has(userId),
  };
}

const hit = (docId: string, source: SearchHit["matchSource"], title = docId): SearchHit => ({
  docId,
  slug: docId,
  title,
  kind: "markdown",
  matchSource: source,
});

describe("parseQuery (S-005)", () => {
  test("trims surrounding whitespace", () => {
    expect(parseQuery("  refund  ")).toBe("refund");
  });
  test("empty query → SearchRejected(empty_query)", () => {
    expect(() => parseQuery("")).toThrow(SearchRejected);
    expect(() => parseQuery("   \n ")).toThrow(SearchRejected);
  });
});

describe("search service (S-005)", () => {
  test("AS-009/C-006: returns accessible content/title/comment matches", async () => {
    const hits = [hit("d1", "content"), hit("d2", "title"), hit("d3", "comment")];
    const access = fakeAccess({
      fields: {
        d1: { ownerId: "u_x", generalAccess: "restricted" }, // owner
        d2: { ownerId: "u_a", generalAccess: "anyone_in_workspace" }, // member
        d3: { ownerId: "u_a", generalAccess: "restricted" }, // invited
      },
      members: new Set(["u_x"]),
      invited: new Set(["d3:u_x"]),
    });
    const deps: SearchDeps = { repo: fakeRepo(hits), access };
    const out = await search({ q: "refund", userId: "u_x", workspaceId: "ws_1" }, deps);
    expect(out.map((r) => r.docId).sort()).toEqual(["d1", "d2", "d3"]);
    // all three match sources are preserved in the shape
    expect(new Set(out.map((r) => r.matchSource))).toEqual(new Set(["content", "title", "comment"]));
  });

  test("AS-009/C-003/H2: a COMMENT-match on an out-of-access doc is DROPPED (no leak)", async () => {
    // d_secret matched only via its comment body, but u_x is NOT invited and it is
    // restricted → the service drops it. Nothing about d_secret survives.
    const hits = [hit("d_ok", "content", "Payment Spec"), hit("d_secret", "comment", "Secret")];
    const access = fakeAccess({
      fields: {
        d_ok: { ownerId: "u_x", generalAccess: "restricted" },
        d_secret: { ownerId: "u_a", generalAccess: "restricted" },
      },
      // u_x not invited to d_secret, not relevant member grant for it.
    });
    const out = await search({ q: "refund", userId: "u_x", workspaceId: "ws_1" }, { repo: fakeRepo(hits), access });
    expect(out.map((r) => r.docId)).toEqual(["d_ok"]);
    const raw = JSON.stringify(out);
    expect(raw).not.toContain("d_secret");
    expect(raw).not.toContain("Secret");
  });

  test("AS-010: projectId is threaded to the repo query (scope)", async () => {
    let seen: SearchQuery | undefined;
    const deps: SearchDeps = { repo: fakeRepo([], (q) => (seen = q)) };
    await search({ q: "invoice", userId: "u_x", projectId: "p_billing", workspaceId: "ws_1" }, deps);
    expect(seen?.projectId).toBe("p_billing");
    expect(seen?.userId).toBe("u_x");
  });

  test("empty query → SearchRejected before the repo is touched", async () => {
    let touched = false;
    const deps: SearchDeps = { repo: fakeRepo([], () => (touched = true)) };
    await expect(search({ q: "   ", userId: "u_x", workspaceId: "ws_1" }, deps)).rejects.toThrow(SearchRejected);
    expect(touched).toBe(false);
  });

  test("results are capped and the cap is logged (never unbounded)", async () => {
    const many = Array.from({ length: 5 }, (_, i) => hit(`d${i}`, "title"));
    const logs: string[] = [];
    const out = await search(
      { q: "x", userId: "u_x", workspaceId: "ws_1" },
      { repo: fakeRepo(many), cap: 3, log: (m) => logs.push(m) },
    );
    expect(out).toHaveLength(3);
    expect(logs.some((l) => l.includes("capped at 3"))).toBe(true);
  });

  test("default cap is SEARCH_RESULT_CAP", () => {
    expect(SEARCH_RESULT_CAP).toBeGreaterThan(0);
  });
});
