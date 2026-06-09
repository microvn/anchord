// Integration tier (guarded by RUN_INTEGRATION): the full route→service→DB path
// for POST /api/docs against a REAL Postgres. Proves a valid publish over the
// HTTP envelope persists a doc + its version-1 row (readable back), and that an
// over-cap artifact is rejected (413) BEFORE anything is written.
//
// The better-auth cookie/session flow is heavy to drive in-test, so the route's
// session resolver is injected with a fake member actor — the point of THIS test
// is the live DB write, not auth (auth is covered by auth-session.itest.ts).
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/docs-routes.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { docVersions, docs, user } from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import { MAX_TEXT_BYTES } from "../../src/publish/sniff";
import type { SessionResolver, WorkspaceRoleResolver } from "../../src/http/auth-gate";
import { createPublishProjectResolver } from "../../src/workspace/repo";
import { withMigratedDb, seedWorkspace, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;
// A real better-auth-shaped TEXT id (NOT a uuid). owner_id/published_by FK → user.id,
// which is text — seeding + writing this proves C-007 end-to-end on real Postgres.
const OWNER_ID = "u_owner1";
const member: SessionResolver = async () => ({ userId: OWNER_ID });
let WS = "";
const asMember: WorkspaceRoleResolver = async () => "member";

function post(body: unknown) {
  return new Request(`http://localhost/api/w/${WS}/docs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!RUN)("POST /api/docs (real Postgres)", () => {
  let h: MigratedDb;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    h = await withMigratedDb();
    // Seed the owner: owner_id / published_by FK → user.id, so the user must exist
    // before a publish can record it. The id is a non-uuid better-auth text id.
    await h.db.insert(user).values({
      id: OWNER_ID,
      name: "Owner One",
      email: "owner1@example.com",
    });
    ({ workspaceId: WS } = await seedWorkspace(h.db, { userId: OWNER_ID, withProject: true }));
    app = createApp({
      dbCheck: async () => {},
      docs: {
        repo: createDocRepo(h.db),
        resolveSession: member,
        resolveWorkspaceRole: asMember,
        resolveProjectId: createPublishProjectResolver(h.db),
      },
    });
  });

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  });

  test("valid publish → 201, doc + version-1 persisted and readable", async () => {
    const res = await app.handle(post({ content: "# Integration\n\nhello", title: "Integ Doc" }));
    expect(res.status).toBe(201);

    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.docId).toBeTruthy();
    expect(json.data.url).toBe(`/d/${json.data.slug}`);

    const docRows = await h.db.select().from(docs).where(eq(docs.id, json.data.docId));
    expect(docRows).toHaveLength(1);
    expect(docRows[0]?.slug).toBe(json.data.slug);
    expect(docRows[0]?.title).toBe("Integ Doc");
    expect(docRows[0]?.kind).toBe("markdown");

    const verRows = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.docId, json.data.docId));
    expect(verRows).toHaveLength(1);
    expect(verRows[0]?.version).toBe(1);
    expect(verRows[0]?.content).toBe("# Integration\n\nhello");
  });

  test("AS-001 / C-007: a signed-in publish persists owner_id + published_by as the text user id", async () => {
    const res = await app.handle(
      post({ content: "<h1>Owned</h1>", kind: "html", title: "Owned Doc" }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;

    // The persisted doc records the session user as owner (C-001), and version 1
    // records the same user as publisher (AS-001). Both columns are TEXT (C-007):
    // this write SUCCEEDS with the non-uuid id "u_owner1" — a uuid-typed column
    // would have rejected it, so a passing write IS the C-007 proof.
    const docRows = await h.db.select().from(docs).where(eq(docs.id, json.data.docId));
    expect(docRows[0]?.ownerId).toBe(OWNER_ID);

    const verRows = await h.db
      .select()
      .from(docVersions)
      .where(eq(docVersions.docId, json.data.docId));
    expect(verRows[0]?.publishedBy).toBe(OWNER_ID);
  });

  test("AS-002 / C-002: a publish with no session is refused (401) and writes nothing", async () => {
    const noSessionApp = createApp({
      dbCheck: async () => {},
      docs: {
        repo: createDocRepo(h.db),
        resolveSession: async () => null,
        resolveWorkspaceRole: asMember,
      },
    });
    const before = await h.db.select().from(docs);
    const res = await noSessionApp.handle(post({ content: "# nope", title: "No Session" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("UNAUTHENTICATED");
    const after = await h.db.select().from(docs);
    expect(after.length).toBe(before.length); // no doc, no owner created
  });

  test("over-cap → 413 and nothing is written", async () => {
    const before = await h.db.select().from(docs);
    const big = "a".repeat(MAX_TEXT_BYTES + 1);
    const res = await app.handle(post({ content: big }));
    expect(res.status).toBe(413);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");

    const after = await h.db.select().from(docs);
    expect(after.length).toBe(before.length); // no doc created
  });
});
