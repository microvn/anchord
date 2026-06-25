// Dev seed — recreates a demo dataset after a reset (`bun db:seed`).
//
// It drives the SAME paths the app uses, so every id it writes is a snowflake (src/db/id.ts):
//   • better-auth signUpEmail → user / account / session  (ids via advanced.database.generateId)
//   • the signup hook auto-creates each user's workspace + default project (snowflake)
//   • drizzle inserts for docs / versions / annotations / comments / share_links — the `id`
//     column's $defaultFn generates the snowflake, so we never pass an id by hand.
//
// What it produces (so a fresh clone has something to look at):
//   • a demo account (owner) + a few reviewer accounts (varied annotation authorship)
//   • two docs — one Markdown (2 versions, for the version diff) and one HTML (rendered in the
//     sandbox iframe with its own styling) — both shared anyone_with_link · commenter
//   • a diverse set of annotations on EACH doc: markup highlight, plain/threaded/resolved
//     comments, a guest comment, every label preset, and replace/delete redline suggestions
//
// Not shipped in prod images; this is a developer convenience for local resets.

import { eq, and, desc, inArray } from "drizzle-orm";
import { Window } from "happy-dom";
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
  shareLinks,
} from "./schema";
import { renderForAnchoring } from "../render/markdown";
import { injectBlockIds } from "../annotation/block-id";
import { DEFAULT_LABEL_PRESETS } from "../annotation/label-presets";
import { mintCapabilityToken } from "../sharing/share-token";
import { BLOCK_SELECTOR } from "@anchord/anchor";

const DEMO_EMAIL = "demo@anchord.test";
const DEMO_PASSWORD = "correct horse battery staple";
const DEMO_NAME = "Demo User";

// Reviewer personas so the annotation rail shows varied authors (not just the owner).
const REVIEWERS = [
  { email: "bob@anchord.test", name: "Bob Reviewer" },
  { email: "priya@anchord.test", name: "Priya Nair" },
  { email: "tom@anchord.test", name: "Tom Member" },
];

// Doc contents live as assets next to this file so the markup is never escaped into a TS literal.
const asset = (rel: string) => Bun.file(new URL(`./seed-assets/${rel}`, import.meta.url)).text();

async function main() {
  const cfg = loadConfig();
  const { db, sql, close } = createDb(cfg.DATABASE_URL);
  const auth = createAuth(db, { secret: cfg.APP_SECRET, baseURL: cfg.APP_URL });

  // 1. Accounts. signUpEmail fires the create hook → each user's own workspace + default
  //    project (snowflake ids). Idempotent: skip if the email already exists.
  const ensureUser = async (email: string, name: string, password: string) => {
    let [u] = await db.select().from(userTable).where(eq(userTable.email, email));
    if (!u) {
      await auth.api.signUpEmail({ body: { email, password, name }, asResponse: false });
      [u] = await db.select().from(userTable).where(eq(userTable.email, email));
    }
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, u!.id));
    return u!;
  };

  const demo = await ensureUser(DEMO_EMAIL, DEMO_NAME, DEMO_PASSWORD);
  const reviewers = [];
  for (const r of REVIEWERS) reviewers.push(await ensureUser(r.email, r.name, DEMO_PASSWORD));
  // Authorship pool: owner first, then reviewers. A guest (null) is added per-doc.
  const authors = [demo.id, ...reviewers.map((r) => r.id)];

  // 2. The demo user's workspace + default project (created by the signup hook).
  const [membership] = await db
    .select().from(workspaceMembers).where(eq(workspaceMembers.userId, demo.id)).limit(1);
  const workspaceId = membership!.workspaceId;
  const [defaultProject] = await db
    .select().from(projectsTable)
    .where(and(eq(projectsTable.workspaceId, workspaceId), eq(projectsTable.isDefault, true)))
    .limit(1);
  const projectId = defaultProject!.id;

  // 3. Docs. Each is anyone_with_link · commenter so a no-account visitor can view AND comment
  //    via the /s/<token> capability link (printed below).
  const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

  const seedDoc = async (title: string, slug: string, kind: "markdown" | "html", versions: string[]) => {
    let [doc] = await db.select().from(docsTable).where(eq(docsTable.slug, slug));
    if (!doc) {
      [doc] = await db.insert(docsTable)
        .values({ slug, title, kind, ownerId: demo.id, projectId, generalAccess: "anyone_with_link" })
        .returning();
    }
    // versions (idempotent: only append above the current max)
    const rows = await db.select().from(docVersions).where(eq(docVersions.docId, doc!.id));
    const maxV = rows.reduce((m, r) => Math.max(m, r.version), 0);
    for (let v = maxV + 1; v <= versions.length; v++) {
      await db.insert(docVersions).values({
        docId: doc!.id, version: v, content: versions[v - 1]!, contentHash: hash(versions[v - 1]!), publishedBy: demo.id,
      });
    }
    // anyone_with_link · commenter share config (one row per doc — upsert by docId)
    const [link] = await db.select().from(shareLinks).where(eq(shareLinks.docId, doc!.id));
    if (!link) {
      await db.insert(shareLinks).values({
        docId: doc!.id, role: "commenter", guestCommenting: true, capabilityToken: mintCapabilityToken(),
      });
    } else {
      await db.update(shareLinks)
        .set({ role: "commenter", guestCommenting: true, capabilityToken: link.capabilityToken ?? mintCapabilityToken() })
        .where(eq(shareLinks.docId, doc!.id));
    }
    return doc!.id;
  };

  const refundV1 = await asset("refund-api-spec.md");
  const refundV2 = await asset("refund-api-spec.v2.md");
  const backtestHtml = await asset("strategy-backtest-report.html");

  const mdDocId = await seedDoc("Refund API — v0 Specification", "refund-api-spec", "markdown", [refundV1, refundV2]);
  const htmlDocId = await seedDoc("Strategy Backtest Report", "strategy-backtest-report", "html", [backtestHtml]);

  // 4. Diverse annotations on each doc (clear-and-reseed so a re-run refreshes them).
  await seedAnnotations(db, mdDocId, authors);
  await seedAnnotations(db, htmlDocId, authors);

  // 5. Report the capability links so a fresh runner can open the commenter view directly.
  const links = await db.select({ docId: shareLinks.docId, token: shareLinks.capabilityToken }).from(shareLinks)
    .where(inArray(shareLinks.docId, [mdDocId, htmlDocId]));
  console.log(`seeded: ${authors.length} accounts · workspace ${workspaceId} · 2 docs`);
  console.log(`login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`viewer (signed in): /d/refund-api-spec · /d/strategy-backtest-report`);
  for (const l of links) console.log(`commenter link (no account): /s/${l.token}`);
  await close();
  await sql.end?.({ timeout: 5 }).catch(() => {});
}

// ── annotation seeding ───────────────────────────────────────────────────────────────────────

/** Ordered [blockId, visible text] for leaf content blocks, as the viewer's locate ladder sees them. */
function blocks(content: string, kind: "html" | "markdown") {
  const html = injectBlockIds(renderForAnchoring(content, kind));
  const win = new Window();
  win.document.body.innerHTML = html;
  const out: { blockId: string; text: string }[] = [];
  for (const el of Array.from(win.document.body.querySelectorAll(BLOCK_SELECTOR)) as any[]) {
    const blockId = el.getAttribute("data-block-id") || el.getAttribute("id");
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!blockId || !blockId.startsWith("block-")) continue;
    if (["ul", "ol", "table", "tr", "pre", "div", "section", "article", "figure", "aside", "nav", "header", "main"].includes(tag)) continue;
    if (text.length < 15) continue;
    out.push({ blockId, text });
  }
  return out;
}

function anchorFor(b: { blockId: string; text: string }) {
  let snippet = b.text, offset = 0;
  if (b.text.length > 55) {
    let s = b.text.indexOf(" "); s = s < 0 ? 0 : s + 1;
    let e = Math.min(b.text.length, s + 45);
    const ns = b.text.indexOf(" ", e); if (ns > 0 && ns - e < 12) e = ns;
    snippet = b.text.slice(s, e); offset = s;
  }
  return {
    blockId: b.blockId, textSnippet: snippet, offset, length: snippet.length,
    prefix: b.text.slice(Math.max(0, offset - 32), offset),
    suffix: b.text.slice(offset + snippet.length, offset + snippet.length + 32),
  };
}

async function seedAnnotations(db: ReturnType<typeof createDb>["db"], docId: string, authors: string[]) {
  await db.delete(annotationsTable).where(eq(annotationsTable.docId, docId)); // comments cascade
  const [v] = await db
    .select({ content: docVersions.content, version: docVersions.version, kind: docsTable.kind })
    .from(docVersions).innerJoin(docsTable, eq(docsTable.id, docVersions.docId))
    .where(eq(docVersions.docId, docId)).orderBy(desc(docVersions.version)).limit(1);
  const bs = blocks(v!.content, v!.kind as "html" | "markdown");
  if (!bs.length) return;

  let bi = 0; const next = () => bs[bi++ % bs.length];
  let ui = 0; const pick = () => authors[ui++ % authors.length];

  const insAnn = async (o: { anchor: any; type: string; label?: string | null; authorId?: string | null; suggestion?: any; suggestionStatus?: string | null; status?: "unresolved" | "resolved" }) => {
    const [row] = await db.insert(annotationsTable).values({
      docId, type: o.type as any, anchor: o.anchor, label: o.label ?? null, authorId: o.authorId ?? null,
      suggestion: o.suggestion ?? null, suggestionStatus: (o.suggestionStatus as any) ?? null, status: (o.status as any) ?? "unresolved",
    }).returning({ id: annotationsTable.id });
    return row!.id;
  };
  const addC = async (annotationId: string, parentId: string | null, authorId: string | null, body: string, guestName?: string) => {
    const [row] = await db.insert(commentsTable).values({ annotationId, parentId, authorId, guestName: guestName ?? null, body }).returning({ id: commentsTable.id });
    return row!.id;
  };

  // markup highlight (with a note so the author name shows)
  { const b = next(); const a = pick(); const id = await insAnn({ anchor: anchorFor(b), type: "range", authorId: a }); await addC(id, null, a, "Highlighting this so it doesn't get missed in review."); }
  // plain comment
  { const b = next(); const a = pick(); const id = await insAnn({ anchor: anchorFor(b), type: "range", authorId: a }); await addC(id, null, a, "This reads a little ambiguous — can we spell out the input and output?"); }
  // threaded (2 replies)
  { const b = next(); const a0 = pick(), a1 = pick(), a2 = pick();
    const id = await insAnn({ anchor: anchorFor(b), type: "range", authorId: a0 });
    const root = await addC(id, null, a0, "Does this cover the partial case, or only the full one?");
    await addC(id, root, a1, "Full only for v0 — partial is deferred.");
    await addC(id, root, a2, "Got it. Let's say so explicitly so nobody assumes partial works."); }
  // resolved
  { const b = next(); const a = pick(); const id = await insAnn({ anchor: anchorFor(b), type: "range", authorId: a, status: "resolved" }); await addC(id, null, a, "Agreed and settled. Resolving."); }
  // guest (no account)
  { const b = next(); const id = await insAnn({ anchor: anchorFor(b), type: "range", authorId: null }); await addC(id, null, null, "Dropping by — a concrete example here would help a lot.", "Guest Reviewer"); }
  // every label preset (each with a short note)
  for (const label of DEFAULT_LABEL_PRESETS) {
    const b = next(); const a = pick();
    const id = await insAnn({ anchor: anchorFor(b), type: "range", label, authorId: a });
    await addC(id, null, a, `Tagged "${label}" for the author to action.`);
  }
  // redline suggestions (replace + delete)
  { const b = next(); const a = pick(); const an = anchorFor(b);
    const id = await insAnn({ anchor: an, type: "suggestion", authorId: a, suggestion: { kind: "replace", from: an.textSnippet, to: an.textSnippet.replace(/\s+/g, " ").trim() + " (clarified)", againstVersion: v!.version }, suggestionStatus: "pending" });
    await addC(id, null, a, "Suggesting a clearer wording here."); }
  { const b = next(); const a = pick(); const an = anchorFor(b);
    const id = await insAnn({ anchor: an, type: "suggestion", authorId: a, suggestion: { kind: "delete", from: an.textSnippet, againstVersion: v!.version }, suggestionStatus: "pending" });
    await addC(id, null, a, "This sentence is redundant — suggest removing it."); }

  const total = await db.select({ id: annotationsTable.id }).from(annotationsTable).where(eq(annotationsTable.docId, docId));
  console.log(`  ${docId}: seeded ${total.length} annotations across ${bi} blocks`);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
