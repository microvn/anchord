// Integration tier (guarded by RUN_INTEGRATION): the access-gated /v/:id content
// route — render-publish S-003/S-004 — over REAL Postgres.
//
// doc-access-routing S-006: the bare server-rendered /d/:slug viewer (createLoadViewer +
// viewerPage) was REMOVED — the share link now opens the in-app SPA viewer. The doc-read
// surface is the doc-scoped GET /api/docs/:slug (covered by viewer-doc.itest.ts /
// doc-viewer-routes.test.ts). This file now guards only the surviving /v/:id content
// surface: the sandboxed iframe content the viewer embeds for html/image docs.
//
// We boot createApp with the REAL createLoadContent loader (the same function index.ts
// wires) over a migrated DB, and assert /v is reachable AND access-gated:
//   - anyone_with_link HTML version → 200 + raw content + the sandbox CSP headers + block-ids.
//   - RESTRICTED version to an anon caller → 404 (existence-hiding, sharing C-003).
//
// The session resolver + resolveDocRole are injected fakes (no better-auth needed):
// the gate logic is what's under test, and it consumes a Viewer + a Role|null — both the
// real contract createApp/the loaders use.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/viewer.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { docs, docVersions } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { CONTENT_SECURITY_POLICY } from "../../src/render/sandbox";
import { createLoadContent } from "../../src/render/viewer-loaders";
import { createResolveAccess } from "../../src/sharing/resolve-access";
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

describe.skipIf(!RUN)("render-publish S-003/S-004: access-gated /v content route (real Postgres)", () => {
  let h: MigratedDb;

  // Fake gate inputs. ANON unless a caller supplies a session; resolveDocRole returns null
  // (no invited/link/workspace/owner role) so a restricted doc is denied to everyone here —
  // the existence-hiding path under test. A test that wants an authorized caller overrides.
  let viewerSession: { userId: string } | null = null;
  let docRole: Role | null = null;

  function buildApp() {
    // doc-access-routing S-001: the loader gates on the single resolveAccess. Built on the
    // REAL createResolveAccess (its anon path reads the seeded doc's general_access +
    // share_links) with a fake resolveDocRole for the logged-in role.
    const deps = {
      db: h.db,
      resolveAccess: createResolveAccess(h.db, {
        resolveDocRole: async (): Promise<Role | null> => docRole,
      }),
    };
    return createApp({
      dbCheck: async () => {},
      loadContent: createLoadContent(deps),
      resolveViewerSession: async () => viewerSession,
      // Mount an enveloped /api group alongside /v so apiEnvelope's `{as:"scoped"}`
      // onAfterHandle propagates to this parent app — reproducing the production condition
      // (index.ts mounts many enveloped groups). The /v route must still serve RAW content
      // (api-core C-009 exempt), NOT the JSON envelope. Without this group the leak can't
      // occur and the no-envelope assertion would be vacuous.
      docs: {
        db: h.db,
        resolveSession: async () => null,
        resolveWorkspaceRole: async () => null,
      },
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
    // Isolation, not stripping: the script is preserved verbatim (it runs, sandboxed by
    // opaque origin). S-006/C-009 injects positional block-ids on the sandbox content too,
    // so the <h1> now carries one — but nothing is removed (the script is untouched).
    expect(body).toContain("<script>window.x=1</script>"); // not stripped — isolation
    expect(body).toContain('<h1 id="block-h1-1">raw untrusted</h1>'); // C-009 block-id marker
    // C-009: served RAW, never wrapped in the api JSON envelope.
    expect(body).not.toContain('"success":true');
  });

  test("non-existent version id → 404 (not 500 — the wiring bug regression)", async () => {
    viewerSession = null;
    docRole = null;
    const res = await buildApp().handle(new Request(`${BASE}/v/does-not-exist-${process.pid}`));
    expect(res.status).toBe(404);
  });

  test("C-003 existence-hiding: restricted doc's version to an anon caller → 404 (no leak)", async () => {
    viewerSession = null; // anon
    docRole = null; // no role
    const { versionId } = await seedDoc(h, {
      kind: "html",
      generalAccess: "restricted",
      content: "<h1>secret</h1>",
    });
    const vRes = await buildApp().handle(new Request(`${BASE}/v/${versionId}`));
    expect(vRes.status).toBe(404);
    const body = await vRes.text();
    expect(body).not.toContain("secret"); // never served
  });

  test("C-003 existence-hiding: restricted version to a logged-in NON-member (no role) → 404", async () => {
    viewerSession = { userId: "u-outsider" };
    docRole = null; // resolveDocRole finds no invited/link/workspace/owner role
    const { versionId } = await seedDoc(h, {
      kind: "html",
      generalAccess: "restricted",
      content: "<h1>also secret</h1>",
    });
    const res = await buildApp().handle(new Request(`${BASE}/v/${versionId}`));
    expect(res.status).toBe(404);
  });
});
