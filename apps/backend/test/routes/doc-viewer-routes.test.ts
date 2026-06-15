// In-process route tests for the doc-access-routing S-002 DOC-ADDRESSED mount,
// GET /api/docs/:slug (no DB, no port). These exercise the HTTP GLUE that is the
// whole point of the story: the slug-only path, the OPTIONAL session (anon-capable),
// the existence-hiding NOT-FOUND that is byte-identical for anon vs signed-in and is
// NEVER a 401, and the markdown-sanitized vs html-sandbox-reference response shape.
//
// A fake `loadViewerDoc` is injected so the route's gating contract runs without a
// Postgres-backed resolveAccess; the real DB-backed access decision is already proven
// by sharing/resolve-access.test.ts + viewer-doc.itest.ts (S-001). What is under test
// HERE is purely the new doc-addressed route glue.
//
// AS / Constraint map:
//   AS-009 / C-010  signed-in viewer reads a markdown doc by slug-only link → rendered.
//   AS-010 / C-004  signed-out (anon) reads an anyone_with_link doc → rendered, no sign-in.
//   AS-011 / C-004  no-access (anon OR signed-in) → 404 NOT_FOUND, byte-identical, NOT 401.
//   AS-012 / C-006  html doc → { contentUrl: "/v/:id" } sandbox ref, never inline html;
//                   markdown is dompurify-sanitized before app-origin render.
//   C-002 / C-007   the doc is found by slug alone — no workspace qualifier in the path.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { ViewerSessionResolver } from "../../src/routes/viewer-doc";
import type { ViewerDocPayload } from "../../src/render/viewer-loaders";
import type { Viewer } from "../../src/sharing/access";

const anon: ViewerSessionResolver = async () => null;
const signedIn: ViewerSessionResolver = async () => ({ userId: "u_reader" });

/** A markdown payload whose content embeds a raw <script> to prove dompurify runs. */
function markdownPayload(): ViewerDocPayload {
  return {
    versionId: "ver_md_1",
    title: "Release Notes",
    kind: "markdown",
    version: 1,
    status: "published",
    generalAccess: "anyone_with_link",
    effectiveRole: "viewer",
    workspaceId: "ws_md",
    content: "# Release Notes\n\n- one\n\n<script>alert(1)</script>",
  };
}

/** An html payload carrying untrusted markup — must NEVER be inlined into the app origin. */
function htmlPayload(): ViewerDocPayload {
  return {
    versionId: "ver_html_9",
    title: "Untrusted",
    kind: "html",
    version: 1,
    status: "published",
    generalAccess: "anyone_with_link",
    effectiveRole: null,
    workspaceId: null,
    content: "<h1>untrusted</h1><script>document.cookie</script>",
  };
}

/**
 * Build the app with a fake doc-addressed loader. `grant` decides access: a payload
 * (access) or null (no-access/missing → existence-hiding). Records the slug the loader
 * was called with so we can assert slug-only addressing (no workspace qualifier).
 */
function buildApp(opts: {
  resolveViewerSession?: ViewerSessionResolver;
  grant: ViewerDocPayload | null;
}): { app: ReturnType<typeof createApp>; calls: { slug: string; viewer: Viewer }[] } {
  const calls: { slug: string; viewer: Viewer }[] = [];
  const loadViewerDoc = async (slug: string, viewer: Viewer) => {
    calls.push({ slug, viewer });
    return opts.grant;
  };
  const app = createApp({
    dbCheck: async () => {},
    docViewer: { resolveViewerSession: opts.resolveViewerSession, loadViewerDoc },
  });
  return { app, calls };
}

function get(slug: string) {
  return new Request(`http://localhost/api/docs/${slug}`);
}

describe("GET /api/docs/:slug — doc-addressed viewer route glue", () => {
  test("AS-009: signed-in viewer reads a markdown doc by a slug-only link → rendered doc returned", async () => {
    const { app, calls } = buildApp({ resolveViewerSession: signedIn, grant: markdownPayload() });
    const res = await app.handle(get("release-notes"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.doc.title).toBe("Release Notes");
    expect(json.data.doc.kind).toBe("markdown");
    // C-006: markdown is rendered to HTML in the app origin (a string, not a sandbox ref).
    expect(typeof json.data.content).toBe("string");
    expect(json.data.content).toContain("Release Notes");
    // The loader saw the slug-only link, and the server-resolved signed-in viewer.
    expect(calls[0]!.slug).toBe("release-notes");
    expect(calls[0]!.viewer).toEqual({ kind: "user", userId: "u_reader" });
  });

  test("AS-010: signed-out (anon) visitor reads an anyone_with_link doc → rendered without sign-in", async () => {
    // No resolver at all → anon. Proves the route is anon-capable (no requireSession).
    const { app, calls } = buildApp({ resolveViewerSession: anon, grant: markdownPayload() });
    const res = await app.handle(get("public-doc"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.content).toContain("Release Notes");
    // The viewer reached the loader as anonymous — no session was required.
    expect(calls[0]!.viewer).toEqual({ kind: "anon" });
  });

  test("AS-011: no-access on a restricted doc → 404 NOT_FOUND, byte-identical for anon vs signed-in, and NOT a 401", async () => {
    // Same grant=null (no access) for both callers; the only difference is the session.
    const anonRes = await buildApp({ resolveViewerSession: anon, grant: null }).app.handle(get("secret"));
    const userRes = await buildApp({ resolveViewerSession: signedIn, grant: null }).app.handle(get("secret"));

    // NOT a 401/unauthenticated — so the FE's global 401 handler can't bounce to sign-in.
    expect(anonRes.status).toBe(404);
    expect(userRes.status).toBe(404);
    const anonJson = (await anonRes.json()) as any;
    const userJson = (await userRes.json()) as any;
    expect(anonJson.error.code).toBe("NOT_FOUND");
    expect(userJson.error.code).toBe("NOT_FOUND");
    expect(anonJson.success).toBe(false);

    // Existence-hiding: byte-identical bodies for anon vs signed-in (ignore per-request
    // jitter — timestamp/requestId — which are not access-revealing).
    const strip = (j: any) => ({ ...j, timestamp: "T", requestId: "R", error: j.error });
    expect(strip(anonJson)).toEqual(strip(userJson));
    // And specifically: the no-access response carries no 401 marker anywhere.
    expect(JSON.stringify(anonJson)).not.toContain("UNAUTHENTICATED");
    expect(JSON.stringify(anonJson)).not.toContain("401");
  });

  test("AS-012 / C-006: html doc → { contentUrl: /v/:id } sandbox reference, NOT inline html", async () => {
    const payload = htmlPayload();
    const { app } = buildApp({ resolveViewerSession: signedIn, grant: payload });
    const res = await app.handle(get("untrusted-doc"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.doc.kind).toBe("html");
    expect(json.data.content).toEqual({ contentUrl: `/v/${payload.versionId}` });
    // C-006: the untrusted HTML must NOT appear inline anywhere in the response.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("<h1>untrusted</h1>");
    expect(raw).not.toContain("document.cookie");
  });

  test("C-006: markdown is dompurify-sanitized before app-origin render (script stripped)", async () => {
    const { app } = buildApp({ resolveViewerSession: signedIn, grant: markdownPayload() });
    const res = await app.handle(get("release-notes"));
    const json = (await res.json()) as any;
    // The raw <script> in the markdown source must be gone from the app-origin HTML.
    expect(json.data.content).not.toContain("<script>");
    expect(json.data.content).not.toContain("alert(1)");
  });

  test("AS-030: the doc-read response carries the doc's OWN workspaceId (member-only Share/Version source it)", async () => {
    // A doc WITH a project → its resolved workspaceId rides the read response so the doc-scoped
    // viewer can feed the workspace-addressed Share dialog + Version history (C-007), which have
    // no :workspaceId URL param on the public route.
    const { app } = buildApp({ resolveViewerSession: signedIn, grant: markdownPayload() });
    const res = await app.handle(get("release-notes"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.doc.workspaceId).toBe("ws_md");
  });

  test("AS-030: a project-less doc reports workspaceId null (no workspace → member panels hidden)", async () => {
    // C-011: a doc with no project has no workspace → workspaceId is null on the response, so the
    // FE hides the member-only Share/Version panels (they have nothing to address).
    const { app } = buildApp({ resolveViewerSession: signedIn, grant: htmlPayload() });
    const res = await app.handle(get("untrusted-doc"));

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.data.doc.workspaceId).toBeNull();
  });

  test("C-002 / C-007: the doc resolves by slug alone — no workspace param in the path", async () => {
    const { app, calls } = buildApp({ resolveViewerSession: signedIn, grant: markdownPayload() });
    // A request with no /api/w/:workspaceId segment resolves the doc purely by slug.
    const res = await app.handle(get("only-a-slug"));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slug).toBe("only-a-slug");
    // The route is mounted at /api/docs/:slug — a workspace-qualified path is a DIFFERENT
    // route and must NOT feed this doc-addressed loader at all (only docViewer is mounted
    // here, so the workspace path is unmatched → it never reaches this loader).
    const { app: app2, calls: calls2 } = buildApp({ resolveViewerSession: signedIn, grant: markdownPayload() });
    await app2.handle(new Request("http://localhost/api/w/ws_1/docs/only-a-slug"));
    expect(calls2).toHaveLength(0);
  });
});
