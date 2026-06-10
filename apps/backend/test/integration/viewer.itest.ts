// Integration tier (guarded by RUN_INTEGRATION): the access-gated doc viewer
// (/d/:slug, /v/:id) — render-publish S-002/S-003/S-004 — over REAL Postgres.
//
// This is the regression net for the live 500 bug: createApp was wired WITHOUT
// loadViewer/loadContent, so every /d/:slug 500'd (the routes were never mounted).
// Here we boot createApp with the REAL loaders (createLoadViewer/createLoadContent
// from render/viewer-loaders.ts — the same functions index.ts wires) over a migrated
// DB, and assert the routes are reachable AND access-gated:
//   - anyone_with_link / anyone_in_workspace markdown doc → 200 + rendered <main class="doc-md">.
//   - anyone_with_link HTML doc → 200 + the sandbox <iframe src="/v/...">.
//   - /v/:id → 200 + raw content + the sandbox CSP headers (render/sandbox.ts).
//   - non-existent slug → 404 (NOT 500 — the bug).
//   - RESTRICTED doc to an anon caller → 404 (existence-hiding, sharing C-003).
//
// The session resolver + resolveDocRole are injected fakes (no better-auth needed):
// the gate logic is what's under test, and it consumes a Viewer + a Role|null — both
// are the real contract createApp/the loaders use. resolveDocRole returns null for the
// anon/non-member callers here, so a restricted doc stays hidden.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/viewer.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { docs, docVersions } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { CONTENT_SECURITY_POLICY } from "../../src/render/sandbox";
import { createLoadViewer, createLoadContent } from "../../src/render/viewer-loaders";
import type { Viewer } from "../../src/sharing/access";
import type { Role } from "../../src/sharing/roles";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
const BASE = "http://localhost";

let seq = 0;
/** Seed a doc + its version 1 directly (controls general_access, which createDocWithV1 can't). */
async function seedDoc(
  h: MigratedDb,
  opts: {
    kind: "html" | "markdown" | "image";
    generalAccess: "restricted" | "anyone_in_workspace" | "anyone_with_link";
    content: string;
  },
): Promise<{ slug: string; versionId: string; docId: string }> {
  const slug = `view-${process.pid}-${++seq}`;
  const [doc] = await h.db
    .insert(docs)
    .values({
      slug,
      title: `Doc ${slug}`,
      kind: opts.kind,
      generalAccess: opts.generalAccess,
    })
    .returning({ id: docs.id });
  const [ver] = await h.db
    .insert(docVersions)
    .values({ docId: doc!.id, version: 1, content: opts.content, contentHash: `h-${slug}` })
    .returning({ id: docVersions.id });
  return { slug, versionId: ver!.id, docId: doc!.id };
}

describe.skipIf(!RUN)("render-publish S-002/S-003/S-004: access-gated viewer (real Postgres)", () => {
  let h: MigratedDb;

  // Fake gate inputs. ANON unless a caller supplies a session; resolveDocRole returns null
  // (no invited/link/workspace/owner role) so a restricted doc is denied to everyone here —
  // the existence-hiding path under test. A test that wants an authorized caller overrides.
  let viewerSession: { userId: string } | null = null;
  let docRole: Role | null = null;

  function buildApp() {
    const deps = {
      db: h.db,
      // Permissive structural ports (mirror index.ts sharedAccessDeps); the authoritative
      // gate for non-open docs is resolveDocRole below.
      accessDeps: { isInvited: () => true, isWorkspaceMember: () => true },
      resolveDocRole: async (): Promise<Role | null> => docRole,
    };
    return createApp({
      dbCheck: async () => {},
      loadViewer: createLoadViewer(deps),
      loadContent: createLoadContent(deps),
      resolveViewerSession: async () => viewerSession,
    });
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

  test("AS-006/AS-009: anyone_in_workspace markdown doc → 200 + rendered doc-md (was 500 before wiring)", async () => {
    viewerSession = { userId: "u-member" };
    docRole = "viewer"; // a workspace member resolves to a concrete role
    const { slug } = await seedDoc(h, {
      kind: "markdown",
      generalAccess: "anyone_in_workspace",
      content: "# Hello\n\nworld",
    });
    const res = await buildApp().handle(new Request(`${BASE}/d/${slug}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<main class="doc-md">');
    expect(html).toContain("Hello");
  });

  test("AS-006: anyone_with_link HTML doc → 200 + sandbox iframe pointing at /v/:id", async () => {
    viewerSession = null; // anon — an anyone_with_link doc admits anon
    docRole = null;
    const { slug, versionId } = await seedDoc(h, {
      kind: "html",
      generalAccess: "anyone_with_link",
      content: "<h1>untrusted</h1><script>1</script>",
    });
    const res = await buildApp().handle(new Request(`${BASE}/d/${slug}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<iframe`);
    expect(html).toContain(`src="/v/${versionId}"`);
    expect(html).toContain(`sandbox="allow-scripts"`);
  });

  test("AS-007: /v/:id → 200 + raw content + sandbox CSP headers", async () => {
    viewerSession = null;
    docRole = null;
    const raw = "<h1>raw untrusted</h1><script>window.x=1</script>";
    const { versionId } = await seedDoc(h, {
      kind: "html",
      generalAccess: "anyone_with_link",
      content: raw,
    });
    const res = await buildApp().handle(new Request(`${BASE}/v/${versionId}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toBe(raw); // served as-is (identity serializer — isolation, not stripping)
  });

  test("non-existent slug → 404 (not 500 — the wiring bug regression)", async () => {
    viewerSession = null;
    docRole = null;
    const res = await buildApp().handle(new Request(`${BASE}/d/does-not-exist-${process.pid}`));
    expect(res.status).toBe(404);
  });

  test("C-003 existence-hiding: restricted doc to an anon caller → 404 (no leak)", async () => {
    viewerSession = null; // anon
    docRole = null; // no role
    const { slug, versionId } = await seedDoc(h, {
      kind: "markdown",
      generalAccess: "restricted",
      content: "# secret",
    });
    const dRes = await buildApp().handle(new Request(`${BASE}/d/${slug}`));
    expect(dRes.status).toBe(404);
    const dBody = await dRes.text();
    expect(dBody).not.toContain("secret"); // never rendered

    // …and the content route hides the same doc's version too.
    const vRes = await buildApp().handle(new Request(`${BASE}/v/${versionId}`));
    expect(vRes.status).toBe(404);
  });

  test("C-003 existence-hiding: restricted doc to a logged-in NON-member (no role) → 404", async () => {
    viewerSession = { userId: "u-outsider" };
    docRole = null; // resolveDocRole finds no invited/link/workspace/owner role
    const { slug } = await seedDoc(h, {
      kind: "markdown",
      generalAccess: "restricted",
      content: "# also secret",
    });
    const res = await buildApp().handle(new Request(`${BASE}/d/${slug}`));
    expect(res.status).toBe(404);
  });
});
