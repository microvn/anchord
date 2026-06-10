// Integration tier (guarded by RUN_INTEGRATION): render-publish S-005 — the in-app
// React viewer's doc loader, GET /api/w/:workspaceId/docs/:slug, over REAL Postgres.
//
// Boots createApp with the SAME loader deps index.ts wires (createLoadViewerDoc via
// viewerLoaderDeps), proving the route is BOTH mounted (app.ts) AND fed its deps
// (index.ts) — the regression net for the earlier viewer-wiring 500 (loader defined
// but never passed). Asserts via app.handle(new Request(...)):
//   - AS-016: markdown doc → 200 + meta (title, kind, version, status, generalAccess)
//     + `content` = sanitized app-theme HTML (script stripped).
//   - AS-017: html doc → 200 + meta + `content` = { contentUrl: "/v/<versionId>" },
//     the untrusted HTML NOT returned inline.
//   - AS-018: restricted doc to a non-member (no role) / a missing slug → 404
//     (existence-hiding, indistinguishable).
//
// The session resolver + resolveDocRole are injected fakes (no better-auth needed):
// the gate logic + the loader/render contract are what's under test.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/viewer-doc.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { docs, docVersions } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createLoadViewerDoc } from "../../src/render/viewer-loaders";
import type { Viewer } from "../../src/sharing/access";
import type { Role } from "../../src/sharing/roles";
import type { WorkspaceRoleResolver, SessionResolver } from "../../src/http/auth-gate";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const BASE = "http://localhost";
const WS = "ws-fixed-for-path"; // the gate reads :workspaceId; resolveWorkspaceRole is faked

let seq = 0;
/** Seed a doc + N versions directly (controls general_access + version count). */
async function seedDoc(
  h: MigratedDb,
  opts: {
    kind: "html" | "markdown" | "image";
    generalAccess: "restricted" | "anyone_in_workspace" | "anyone_with_link";
    versions: string[]; // content per version, version numbers 1..N
  },
): Promise<{ slug: string; versionId: string; docId: string }> {
  const slug = `vdoc-${process.pid}-${++seq}`;
  const [doc] = await h.db
    .insert(docs)
    .values({ slug, title: `Doc ${slug}`, kind: opts.kind, generalAccess: opts.generalAccess })
    .returning({ id: docs.id });
  let lastVersionId = "";
  for (let i = 0; i < opts.versions.length; i++) {
    const [ver] = await h.db
      .insert(docVersions)
      .values({ docId: doc!.id, version: i + 1, content: opts.versions[i]!, contentHash: `h-${slug}-${i}` })
      .returning({ id: docVersions.id });
    lastVersionId = ver!.id;
  }
  return { slug, versionId: lastVersionId, docId: doc!.id };
}

describe.skipIf(!RUN)("render-publish S-005: in-app viewer doc loader (real Postgres)", () => {
  let h: MigratedDb;

  // Fake gate inputs. A logged-in member by default; resolveDocRole returns a role so a
  // non-open doc is visible. A test overrides these (e.g. AS-018) to deny.
  let viewerSession: { userId: string } | null = { userId: "u-member" };
  let docRole: Role | null = "viewer";
  let workspaceRole: "admin" | "member" | null = "member";

  const resolveSession: SessionResolver = async () => (viewerSession ? { userId: viewerSession.userId } : null);
  const resolveWorkspaceRole: WorkspaceRoleResolver = async () => workspaceRole;

  function buildApp() {
    const loaderDeps = {
      db: h.db,
      accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
      resolveDocRole: async (): Promise<Role | null> => docRole,
    };
    return createApp({
      dbCheck: async () => {},
      viewerDoc: { resolveSession, resolveWorkspaceRole, loaderDeps },
    });
  }

  function get(slug: string) {
    return new Request(`${BASE}/api/w/${WS}/docs/${slug}`);
  }

  beforeAll(async () => {
    h = await withMigratedDb();
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("AS-016: markdown doc → 200 + meta (title/kind/version/status/generalAccess) + sanitized app-theme HTML", async () => {
    viewerSession = { userId: "u-member" };
    docRole = "viewer";
    workspaceRole = "member";
    // version 3 (AS-016 data: a markdown doc at version 3); a raw <script> proves dompurify (C-002).
    const { slug } = await seedDoc(h, {
      kind: "markdown",
      generalAccess: "anyone_in_workspace",
      versions: ["# v1", "# v2", "# Release Notes\n\n- one\n- two\n\n<script>alert(1)</script>"],
    });
    const res = await buildApp().handle(get(slug));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    // meta — every field the AS lists
    expect(json.data.doc.title).toBe(`Doc ${slug}`);
    expect(json.data.doc.kind).toBe("markdown");
    expect(json.data.doc.version).toBe(3); // CURRENT (highest) version
    expect(json.data.doc.status).toBe("published");
    expect(json.data.doc.generalAccess).toBe("anyone_in_workspace");
    // content — sanitized HTML in the app theme (markdown rendered, NOT a sandbox ref)
    expect(typeof json.data.content).toBe("string");
    expect(json.data.content).toContain("Release Notes");
    expect(json.data.content).toContain("<li>one</li>");
    expect(json.data.content).not.toContain("<script>"); // C-002 dompurify stripped it
  });

  test("AS-017: html doc → 200 + meta + a sandbox /v reference (contentUrl), NOT inline html", async () => {
    viewerSession = null; // anon — an anyone_with_link doc admits anon… but the route is session-gated
    // S-005 is session-gated (viewer+), so use a logged-in caller; anyone_with_link still resolves.
    viewerSession = { userId: "u-member" };
    docRole = null; // anyone_with_link is open → no concrete role needed
    workspaceRole = "member";
    const untrusted = "<h1>untrusted</h1><script>document.cookie</script>";
    const { slug, versionId } = await seedDoc(h, {
      kind: "html",
      generalAccess: "anyone_with_link",
      versions: [untrusted],
    });
    const res = await buildApp().handle(get(slug));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.doc.kind).toBe("html");
    expect(json.data.doc.version).toBe(1);
    expect(json.data.doc.status).toBe("published");
    // content is the sandbox reference, NOT the raw html string
    expect(json.data.content).toEqual({ contentUrl: `/v/${versionId}` });
    // the untrusted HTML must NOT appear inline anywhere in the response (C-008)
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("<h1>untrusted</h1>");
    expect(raw).not.toContain("document.cookie");
  });

  test("AS-018: a restricted doc to a logged-in NON-member (no role) → 404 (existence-hiding)", async () => {
    viewerSession = { userId: "u-outsider" };
    docRole = null; // resolveDocRole finds no invited/link/workspace/owner role
    workspaceRole = "member"; // a workspace member, but not granted on THIS restricted doc
    const { slug } = await seedDoc(h, {
      kind: "markdown",
      generalAccess: "restricted",
      versions: ["# secret content"],
    });
    const res = await buildApp().handle(get(slug));
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("secret content"); // never rendered/leaked
  });

  test("AS-018: a non-existent slug → 404, indistinguishable from no-access", async () => {
    viewerSession = { userId: "u-member" };
    docRole = "viewer";
    workspaceRole = "member";
    const res = await buildApp().handle(get(`does-not-exist-${process.pid}`));
    expect(res.status).toBe(404);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});
