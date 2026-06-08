import { test, expect } from "bun:test";
import {
  createSuggestion,
  decideSuggestion,
  type SuggestionRepo,
  type SuggestionRow,
} from "./suggestion";
import type { Anchor } from "./annotation";

// annotation-core S-006 — suggestion annotation. Pure authz + status logic against a
// fake repo (mirrors resolve.test.ts / annotation.test.ts). The select->"suggest
// replace"->margin UI and the "display stale differently from pending" surface are
// FRONTEND [→MANUAL]; applying the change into content is the MCP round-trip
// (mcp-roundtrip cluster). This module owns: the create path (typed suggestion, NO
// content mutation), the accept/reject status toggle, and the at-accept stale check.
//
// C-003 structural guarantee: the SuggestionRepo deliberately exposes NO method that
// writes doc/version content. So "a suggestion never edits content" is not merely
// asserted by value — it is impossible to express through this port. The fake repo
// below records every method call so a test can prove no content-write was attempted.

const ANCHOR: Anchor = {
  // The block whose text is "Timeout is 24h." in v3.
  blockId: "block-p-1",
  textSnippet: "24h",
  offset: 11,
  length: 3,
};

// v3 content: the suggestion's `from` ("24h") IS present at the anchor block.
const V3_HTML = "<p>Timeout is 24h.</p>";
// v4 content: "24h" has been rewritten to "two days" — `from` no longer matches.
const V4_HTML = "<p>Timeout is two days.</p>";

// A fake repo backing one suggestion. Records every call so we can prove (a) the
// suggestion was stored with the right shape and (b) NO content-write path was hit
// (there is no content-write method on the port at all — C-003).
function fakeRepo(seed?: SuggestionRow): SuggestionRepo & {
  inserted: SuggestionRow[];
  statusWrites: Array<{ id: string; status: string }>;
  store: Map<string, SuggestionRow>;
} {
  const store = new Map<string, SuggestionRow>();
  if (seed) store.set(seed.id, seed);
  const inserted: SuggestionRow[] = [];
  const statusWrites: Array<{ id: string; status: string }> = [];
  return {
    inserted,
    statusWrites,
    store,
    async insertSuggestion(row: SuggestionRow) {
      store.set(row.id, row);
      inserted.push(row);
      return { id: row.id };
    },
    async getSuggestion(id: string) {
      return store.get(id) ?? null;
    },
    async setSuggestionStatus(id: string, status) {
      const row = store.get(id);
      if (row) store.set(id, { ...row, status });
      statusWrites.push({ id, status });
    },
  };
}

test("AS-014 / C-003: create a replace suggestion — typed (replace, from->to), default status pending, doc content unchanged", async () => {
  // Given the reviewer selects a text range; When they choose "suggest replace" and
  // enter the replacement. Data: replace "24h" -> "48h".
  const repo = fakeRepo();

  const res = await createSuggestion(
    {
      docId: "doc-1",
      anchor: ANCHOR,
      from: "24h",
      to: "48h",
      againstVersion: 3,
      sessionRole: "commenter",
    },
    repo,
  );

  expect(res.created).toBe(true);
  if (!res.created) throw new Error("expected created");

  // Then a suggestion-type annotation exists: kind=replace, from->to, default pending.
  const row = repo.store.get(res.id)!;
  expect(row.type).toBe("suggestion");
  expect(row.suggestion).toEqual({ kind: "replace", from: "24h", to: "48h", againstVersion: 3 });
  expect(row.status).toBe("pending");

  // C-003: the doc content does NOT change — the repo exposes no content-write method,
  // so the only writes recorded are the suggestion insert itself. No status write, and
  // structurally there is nowhere for content to be mutated.
  expect(repo.inserted).toHaveLength(1);
  expect(repo.statusWrites).toHaveLength(0);
  expect("setDocContent" in repo).toBe(false);
  expect("setVersionContent" in repo).toBe(false);
});

test("AS-014: a viewer cannot create a suggestion (server-side authz, nothing stored)", async () => {
  // Error path: viewer lacks "comment". Mirrors S-001 create — the repo is never touched.
  const repo = fakeRepo();

  const res = await createSuggestion(
    {
      docId: "doc-1",
      anchor: ANCHOR,
      from: "24h",
      to: "48h",
      againstVersion: 3,
      sessionRole: "viewer",
    },
    repo,
  );

  expect(res).toEqual({ created: false, reason: "forbidden" });
  expect(repo.inserted).toHaveLength(0);
  expect(repo.store.size).toBe(0);
});

test("AS-015 / C-003: accept only changes status to accepted — doc content stays intact (applied via MCP, not here)", async () => {
  // Given a pending suggestion pinned to v3 whose `from`="24h" still matches in the
  // CURRENT version content. When the author clicks accept. Data: accept a replace.
  const seed: SuggestionRow = {
    id: "sug-1",
    docId: "doc-1",
    type: "suggestion",
    anchor: ANCHOR,
    suggestion: { kind: "replace", from: "24h", to: "48h", againstVersion: 3 },
    status: "pending",
  };
  const repo = fakeRepo(seed);

  const res = await decideSuggestion(
    { suggestionId: "sug-1", decision: "accept", currentVersionContentHtml: V3_HTML },
    repo,
  );

  // Then status -> accepted; content is NOT edited here (no content-write method exists;
  // applying is the MCP round-trip). Only a status write was recorded.
  expect(res).toEqual({ ok: true, status: "accepted" });
  expect(repo.store.get("sug-1")!.status).toBe("accepted");
  expect(repo.statusWrites).toEqual([{ id: "sug-1", status: "accepted" }]);
});

test("AS-015 / C-003: reject only changes status to rejected — content untouched", async () => {
  // Reject is a separate atom from accept (per spec NOTE: two AS-015 test nodes).
  // Reject does not even need a from-match check — content is never touched either way.
  const seed: SuggestionRow = {
    id: "sug-1",
    docId: "doc-1",
    type: "suggestion",
    anchor: ANCHOR,
    suggestion: { kind: "replace", from: "24h", to: "48h", againstVersion: 3 },
    status: "pending",
  };
  const repo = fakeRepo(seed);

  const res = await decideSuggestion(
    { suggestionId: "sug-1", decision: "reject", currentVersionContentHtml: V3_HTML },
    repo,
  );

  expect(res).toEqual({ ok: true, status: "rejected" });
  expect(repo.store.get("sug-1")!.status).toBe("rejected");
  expect(repo.statusWrites).toEqual([{ id: "sug-1", status: "rejected" }]);
});

test("AS-022 / C-011: accept goes stale when `from` no longer matches at the anchor (v4 rewrote 24h) — not accepted, not auto-applied", async () => {
  // Given suggestion "replace 24h->48h" pinned to against_version 3; the author
  // republishes v4 in which "24h" was rewritten to "two days". When accept (or an agent
  // applies it via MCP) — at accept time we verify the `from` span still matches at the
  // anchor in the CURRENT version content. Data: v4 no longer contains "24h".
  const seed: SuggestionRow = {
    id: "sug-1",
    docId: "doc-1",
    type: "suggestion",
    anchor: ANCHOR,
    suggestion: { kind: "replace", from: "24h", to: "48h", againstVersion: 3 },
    status: "pending",
  };
  const repo = fakeRepo(seed);

  const res = await decideSuggestion(
    { suggestionId: "sug-1", decision: "accept", currentVersionContentHtml: V4_HTML },
    repo,
  );

  // Then: from="24h" no longer matches -> mark stale, do NOT mark accepted, do NOT
  // auto-apply. Stale is a distinct status from pending (so the UI can display it
  // differently — that surface is [→MANUAL]).
  expect(res).toEqual({ ok: true, status: "stale" });
  const row = repo.store.get("sug-1")!;
  expect(row.status).toBe("stale");
  expect(row.status).not.toBe("accepted");
  expect(row.status).not.toBe("pending");
  // Only the stale status write happened — no accepted write, no content write path.
  expect(repo.statusWrites).toEqual([{ id: "sug-1", status: "stale" }]);
});

test("C-011: a missing suggestion is a clean error path — nothing written", async () => {
  // Boundary / error path: deciding on a suggestion the repo doesn't have must not
  // write anything.
  const repo = fakeRepo();

  const res = await decideSuggestion(
    { suggestionId: "nope", decision: "accept", currentVersionContentHtml: V3_HTML },
    repo,
  );

  expect(res).toEqual({ ok: false, reason: "not_found" });
  expect(repo.statusWrites).toHaveLength(0);
});
