// Dev seed — recreates a minimal demo dataset after a reset (`bun db:seed`).
//
// It drives the SAME paths the app uses, so every id it writes is a snowflake (src/db/id.ts):
//   • better-auth signUpEmail → user / account / session  (ids via advanced.database.generateId)
//   • the signup hook auto-creates the demo user's workspace + default project (snowflake)
//   • drizzle inserts for docs / versions / annotations / comments — the `id` column's
//     $defaultFn generates the snowflake, so we never pass an id by hand.
//
// Not shipped in prod images; this is a developer convenience for local resets.

import { eq, and } from "drizzle-orm";
import { loadConfig } from "../config/env";
import { createDb } from "./client";
import { createAuth } from "../auth/auth";
import {
  user as userTable,
  workspaceMembers,
  projects as projectsTable,
  docs as docsTable,
  docVersions,
  annotations as annotationsTable,
  comments as commentsTable,
} from "./schema";

const DEMO_EMAIL = "demo@anchord.test";
const DEMO_PASSWORD = "correct horse battery staple";
const DEMO_NAME = "Demo User";

const MARKDOWN = `# Auth Spec

Anchord authenticates with **email + password**, magic link, and GitHub OAuth. Identity rides a server-side session cookie — there is no client-stored token.

## Session model

The session is a DB-backed record keyed by an opaque cookie. On expiry the client bounces to \`/signin\` without leaking which docs exist.

- **Viewer** — read only
- **Commenter** — read and comment
- **Owner** — full control, including share settings

Hydrate the client from the [bootstrap endpoint](https://anchord.local/api/me).

> Auth (how you log in) is separate from roles (what you can do after).

\`\`\`ts
const session = await auth.api.getSession({ headers });
if (!session) return redirect("/signin");
\`\`\`
`;

const HTML = `<h1>Render Pipeline</h1><p>This artifact renders in a sandboxed iframe — author styles are preserved, the app never styles it.</p>`;

async function main() {
  const cfg = loadConfig();
  const { db, sql, close } = createDb(cfg.DATABASE_URL);
  const auth = createAuth(db, { secret: cfg.APP_SECRET, baseURL: `http://localhost:${cfg.PORT}` });

  // 1. Demo user (idempotent: skip if already present). signUpEmail fires the create hook →
  //    the user's own workspace + default project are created, all with snowflake ids.
  let [existing] = await db.select().from(userTable).where(eq(userTable.email, DEMO_EMAIL));
  if (!existing) {
    await auth.api.signUpEmail({
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
      asResponse: false,
    });
    [existing] = await db.select().from(userTable).where(eq(userTable.email, DEMO_EMAIL));
  }
  const u = existing!;
  // Bypass the email-verification gate so the demo account can sign in locally.
  await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, u.id));

  // 2. The demo user's workspace + default project (created by the signup hook).
  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, u.id))
    .limit(1);
  const workspaceId = membership!.workspaceId;
  const [defaultProject] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.workspaceId, workspaceId), eq(projectsTable.isDefault, true)))
    .limit(1);
  const projectId = defaultProject!.id;

  // 3. Two docs (markdown + html), each with a v1. ids auto-generate (snowflake) via $defaultFn.
  const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
  const seedDoc = async (
    title: string,
    slug: string,
    kind: "markdown" | "html",
    content: string,
    generalAccess: "restricted" | "anyone_with_link",
  ) => {
    const existingDoc = await db.select().from(docsTable).where(eq(docsTable.slug, slug));
    if (existingDoc.length) return existingDoc[0]!.id;
    const [doc] = await db
      .insert(docsTable)
      .values({ slug, title, kind, ownerId: u.id, projectId, generalAccess })
      .returning();
    await db.insert(docVersions).values({
      docId: doc!.id,
      version: 1,
      content,
      contentHash: hash(content),
      publishedBy: u.id,
    });
    return doc!.id;
  };

  const mdDocId = await seedDoc("Auth Spec", "auth-spec", "markdown", MARKDOWN, "anyone_with_link");
  await seedDoc("Render Pipeline RFC", "render-pipeline-rfc", "html", HTML, "anyone_with_link");

  // 4. One annotation + comment on the markdown doc (anchored to "email + password" in block-p-1).
  const existingAnno = await db
    .select()
    .from(annotationsTable)
    .where(eq(annotationsTable.docId, mdDocId));
  if (!existingAnno.length) {
    const [anno] = await db
      .insert(annotationsTable)
      .values({
        docId: mdDocId,
        type: "range",
        anchor: { blockId: "block-p-1", textSnippet: "email + password", offset: 27, length: 16 },
        status: "unresolved",
      })
      .returning();
    await db.insert(commentsTable).values({
      annotationId: anno!.id,
      authorId: u.id,
      body: "Should we list the magic-link flow here too, or keep it to a separate doc?",
    });
  }

  console.log(`seeded: user ${u.id} · workspace ${workspaceId} · 2 docs (/d/auth-spec, /d/render-pipeline-rfc)`);
  console.log(`login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  await close();
  await sql.end?.({ timeout: 5 }).catch(() => {});
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
