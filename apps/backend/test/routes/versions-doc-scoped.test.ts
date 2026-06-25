// doc-access-routing S-005 — DOC-ADDRESSED version read routes (history + diff).
//
// S-005 carves the version READ surface out of the workspace-scoped mount so a viewer
// reaches it through the doc link alone (C-007): `GET /api/docs/:slug/versions` and
// `GET /api/docs/:slug/diff` — session OPTIONAL (anon-capable for an anyone_with_link
// doc), gated by the single `resolveAccess` (S-001), existence-hiding 404 for no-access
// (same outcome as the doc read, AS-025). The workspace-scoped routes stay (writes need
// workspace context); these doc-scoped reads are additive.
//
// AS map (doc-access-routing):
//   AS-024  history + diff via the doc link (doc-scoped), happy
//   AS-025  no access → 404 (same existence-hiding as the doc read)
//   AS-026  /v serves the requested historical version (pinned in viewer-loaders test)

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import { createLoadContent } from "../../src/render/viewer-loaders";
import type { Viewer } from "../../src/sharing/access";
import type { AccessResult } from "../../src/sharing/resolve-access";
import type { VersionRepo, NewVersionRow } from "../../src/services/version";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Doc One",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};

function fakeVersionRepo(seed: { version: number; content: string; contentHash: string }[] = []) {
  const rows = seed.map((s) => ({ ...s, createdAt: new Date(), publishedBy: null as string | null }));
  const calls = { inserts: [] as NewVersionRow[], titles: [] as string[] };
  const repo: VersionRepo = {
    async currentMaxVersion(_docId) {
      return rows.length ? Math.max(...rows.map((r) => r.version)) : null;
    },
    async insertVersion(row) {
      calls.inserts.push(row);
      rows.push({
        version: row.version,
        content: row.content,
        contentHash: row.contentHash,
        createdAt: new Date(),
        publishedBy: row.publishedBy ?? null,
      });
      return { version: row.version };
    },
    async setTitle(_docId, title) {
      calls.titles.push(title);
    },
    async listVersions(_docId) {
      return rows
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((r) => ({
          version: r.version,
          createdAt: r.createdAt,
          publishedBy: r.publishedBy,
          publishedByName: null as string | null,
        }));
    },
    async getVersion(_docId, version) {
      const hit = rows.find((r) => r.version === version);
      return hit ? { content: hit.content, contentHash: hit.contentHash } : null;
    },
  };
  return { repo, calls, rows };
}

function fakeLookupRepo(doc: DocLookup | null, versionRepo?: ReturnType<typeof fakeVersionRepo>): DocLookupRepo {
  return {
    async findDocBySlug(_slug) {
      return doc;
    },
    async getVersionContent(_docId, version) {
      if (!versionRepo) return null;
      const hit = await versionRepo.repo.getVersion("", version);
      return hit ? { id: `ver_${version}`, ...hit } : null;
    },
  };
}

/** Build an app exercising the DOC-SCOPED (slug-only, anon-capable) version reads. */
function buildApp(opts: {
  /** Optional session resolved from the raw Request — null = anonymous (anon-capable). */
  resolveViewerSession?: (request: Request) => Promise<{ userId: string } | null>;
  /** The single read gate. Default admits (canView true). */
  resolveAccess?: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  doc?: DocLookup | null;
  versionRepo?: ReturnType<typeof fakeVersionRepo>;
}) {
  const vr = opts.versionRepo ?? fakeVersionRepo();
  const lookup = fakeLookupRepo(opts.doc === undefined ? VISIBLE_DOC : opts.doc, vr);
  return createApp({
    dbCheck: async () => {},
    versions: {
      versionRepo: vr.repo,
      lookupRepo: lookup,
      // session-gated (workspace) path still needs these, but the doc-scoped reads ignore them.
      resolveSession: async () => null,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole: async () => "viewer",
      resolveAccess: opts.resolveAccess ?? (async () => ({ role: "viewer", canView: true })),
      // S-005: the optional viewer-session resolver makes the doc-scoped reads anon-capable.
      resolveViewerSession: opts.resolveViewerSession ?? (async () => null),
    },
  });
}

function req(path: string) {
  return new Request(`http://localhost${path}`);
}

describe("GET /api/docs/:slug/versions + /diff (doc-scoped, S-005)", () => {
  test("AS-024: a viewer reads history and a diff via the doc link (doc-scoped, anon)", async () => {
    const vr = fakeVersionRepo([
      { version: 1, content: "line a", contentHash: "h1" },
      { version: 2, content: "line b", contentHash: "h2" },
    ]);
    // Anonymous visitor on an anyone_with_link doc — resolveAccess admits at viewer.
    const app = buildApp({ versionRepo: vr, resolveViewerSession: async () => null });

    // History, addressed by the doc (no /api/w/:workspaceId prefix).
    const hist = await app.handle(req("/api/docs/doc-one/versions"));
    expect(hist.status).toBe(200);
    const histJson = (await hist.json()) as any;
    expect(histJson.success).toBe(true);
    expect(histJson.data.items).toHaveLength(2);
    expect(histJson.data.items[0].version).toBe(2);
    expect(histJson.data.items[0].isCurrent).toBe(true);
    expect(histJson.data.pagination.total).toBe(2);

    // Diff v1 ↔ v2, addressed by the doc.
    const diff = await app.handle(req("/api/docs/doc-one/diff?from=1&to=2"));
    expect(diff.status).toBe(200);
    const diffJson = (await diff.json()) as any;
    expect(diffJson.data.mode).toBe("text");
    expect(diffJson.data.changeCount).toBeGreaterThan(0);
    // Each side references its OWN version surface (not the current one) — /v/<rowId>.
    expect(diffJson.data.renderPair).toEqual(["/v/ver_1", "/v/ver_2"]);
  });

  test("AS-025: no access → 404 history (same existence-hiding as the doc read), byte-identical anon vs signed-in", async () => {
    const vr = fakeVersionRepo([{ version: 1, content: "v1", contentHash: "h1" }]);
    const deny = async (): Promise<AccessResult> => ({ role: null, canView: false });

    // Anonymous: denied → 404 NOT_FOUND, never 401.
    const anonApp = buildApp({
      versionRepo: vr,
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      resolveAccess: deny,
      resolveViewerSession: async () => null,
    });
    const anon = await anonApp.handle(req("/api/docs/doc-one/versions"));
    expect(anon.status).toBe(404);
    const anonJson = (await anon.json()) as any;
    expect(anonJson.error.code).toBe("NOT_FOUND");

    // Signed-in non-member: SAME 404 (existence-hiding) — not a 403 thread/version leak.
    const signedApp = buildApp({
      versionRepo: vr,
      doc: { ...VISIBLE_DOC, generalAccess: "restricted" },
      resolveAccess: deny,
      resolveViewerSession: async () => ({ userId: "u_outsider" }),
    });
    const signed = await signedApp.handle(req("/api/docs/doc-one/versions"));
    expect(signed.status).toBe(404);
    const signedJson = (await signed.json()) as any;
    expect(signedJson.error.code).toBe("NOT_FOUND");
    // Existence-hiding: the no-access outcome is identical for anon vs signed-in — same
    // status + same error envelope (the envelope's timestamp/requestId are inherently
    // per-request and carry no doc info, so they're excluded from the leak comparison).
    expect(signed.status).toBe(anon.status);
    expect(signedJson.success).toBe(anonJson.success);
    expect(signedJson.error).toEqual(anonJson.error);

    // The diff surface denies the same way.
    const diff = await anonApp.handle(req("/api/docs/doc-one/diff?from=1&to=1"));
    expect(diff.status).toBe(404);
  });

  test("AS-025: missing doc → 404 (indistinguishable from no-access)", async () => {
    const app = buildApp({ doc: null });
    const res = await app.handle(req("/api/docs/nope/versions"));
    expect(res.status).toBe(404);
  });
});

// AS-026 / F12: the /v content surface is addressed by VERSION ID and must serve THAT
// version's content — NOT the doc's current version. createLoadContent resolves the row by
// its versionId (createLoadViewerDoc is the slug→current loader; they must NOT be merged).
// A fake DB stub returns the row keyed by the SELECTed versionId so the assertion pins the
// addressing: requesting v1's id while v2 is current returns v1's content.
describe("createLoadContent serves the requested historical version (AS-026)", () => {
  // Two versions of doc_1: v1 (historical) and v2 (current/highest). Each row keyed by its
  // OWN version-row id, joined to the doc — exactly the shape createLoadContent SELECTs.
  // doc-access-two-axis S-001: the join now reads the two share_links axes (a link axis on
  // models the old anyone_with_link). The access decision is delegated to resolveAccess (stubbed
  // per test), so the axes here only need to make deriveLevel non-throwing.
  const VERSION_ROWS: Record<string, { content: string; docId: string; kind: "html" | "markdown" | "image"; workspaceRole: "viewer" | "commenter" | "editor" | null; linkRole: "viewer" | "commenter" | "editor" | null }> = {
    ver_v1: { content: "<h1>V1 historical body</h1>", docId: "doc_1", kind: "html", workspaceRole: null, linkRole: "commenter" },
    ver_v2: { content: "<h1>V2 current body</h1>", docId: "doc_1", kind: "html", workspaceRole: null, linkRole: "commenter" },
  };

  // Minimal fake of the Drizzle chain createLoadContent uses:
  // db.select(...).from(docVersions).innerJoin(docs, ...).where(eq(docVersions.id, id)).limit(1)
  // The `where(eq(...))` clause carries the bound versionId; the fake reads it back to return
  // ONLY that row — so a wrong (current-version) addressing would surface as wrong content.
  function fakeDb(requestedId: { value?: string }) {
    const chain = {
      select: () => chain,
      from: () => chain,
      innerJoin: () => chain,
      leftJoin: () => chain,
      where: (clause: any) => {
        // drizzle's eq(col, val) exposes the bound value; grab it however it's shaped.
        const val =
          clause?.value ??
          clause?.right?.value ??
          clause?.queryChunks?.find?.((c: any) => typeof c?.value === "string")?.value;
        requestedId.value = val;
        return chain;
      },
      limit: async () => {
        const id = requestedId.value;
        const row = id ? VERSION_ROWS[id] : undefined;
        return row ? [row] : [];
      },
    };
    return chain;
  }

  test("AS-026: requesting v1's content while v2 is current serves v1's content, gated by the version's doc", async () => {
    const requestedId: { value?: string } = {};
    const seen: string[] = [];
    const loadContent = createLoadContent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb(requestedId) as any,
      resolveAccess: async (docId) => {
        seen.push(docId);
        return { role: "viewer", canView: true };
      },
    });

    const v1 = await loadContent("ver_v1", { kind: "anon" });
    expect(v1).not.toBeNull();
    // The OLD version's content is served — NOT the current (v2) one.
    expect(v1!.content).toBe("<h1>V1 historical body</h1>");
    expect(v1!.content).not.toContain("V2 current");
    // The loader resolved by the requested version id, and gated on THAT version's doc.
    expect(requestedId.value).toBe("ver_v1");
    expect(seen).toEqual(["doc_1"]);
  });

  test("AS-026: a no-access caller on the version surface → null (existence-hiding, same gate)", async () => {
    const requestedId: { value?: string } = {};
    const loadContent = createLoadContent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: fakeDb(requestedId) as any,
      resolveAccess: async () => ({ role: null, canView: false }),
    });
    const denied = await loadContent("ver_v1", { kind: "anon" });
    expect(denied).toBeNull();
  });
});
