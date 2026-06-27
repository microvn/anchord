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
//   • a CURATED, semantically-matched annotation set on EACH doc: each comment is written for
//     the exact phrase it highlights (markup / plain / threaded / resolved / guest comments,
//     every label preset, and replace/delete redline suggestions)
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
import { extractText } from "../render/extract-text";
import { injectBlockIds } from "../annotation/block-id";
import { mintCapabilityToken } from "../sharing/share-token";
import { BLOCK_SELECTOR } from "@anchord/anchor";

const DEMO_EMAIL = "demo@anchord.microvn.net";
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

// ── curated annotations ────────────────────────────────────────────────────────────────────────
// Each entry targets an EXACT phrase in the (latest-version) rendered text; `body`/`replies` are
// written to fit THAT phrase. `q` must be a substring of one block's whitespace-normalized text.
type Anno =
  | { q: string; t: "highlight" | "comment"; body: string }
  | { q: string; t: "thread"; body: string; replies: string[] }
  | { q: string; t: "resolved"; body: string }
  | { q: string; t: "guest"; body: string }
  | { q: string; t: "label"; label: string; body: string }
  | { q: string; t: "replace"; to: string; body: string }
  | { q: string; t: "delete"; body: string };

const REFUND_ANNOS: Anno[] = [
  { q: "moves money back to the customer", t: "highlight", body: "Clear one-line definition — anchoring it for the glossary." },
  { q: "an idempotency key the caller generates once per logical attempt", t: "comment", body: "How long is a key retained for dedup? Worth stating the window." },
  { q: "A refund always reverses the full captured amount", t: "thread", body: "So there's no way to do a partial from this endpoint?", replies: ["Right — partial is deferred to v1.", "Then let's make the typed error on `amount` very explicit."] },
  { q: "currency conversion are explicitly deferred to v1", t: "resolved", body: "Scope confirmed with product. Resolving." },
  { q: "120-day processor window", t: "guest", body: "Is the 120-day window fixed, or configurable per processor?" },
  { q: "returns the original refund resource unchanged", t: "label", label: "looks-good", body: "Clean idempotency contract — exactly what callers need." },
  { q: "settles out of band", t: "label", label: "clarify-this", body: "Clarify how the caller learns settlement finished — webhook or poll?" },
  { q: "what it accepts, what it guarantees", t: "label", label: "missing-overview", body: "A short TL;DR box at the top would help skimmers." },
  { q: "returns 201 with the refund resource", t: "label", label: "verify-this", body: "Verify it's 201 (created), not 200." },
  { q: "POST /v1/refunds", t: "label", label: "give-example", body: "Add an example response body next to the request sample." },
  { q: "Return a typed error for every refusal", t: "label", label: "match-patterns", body: "Make the error shape match the rest of the API." },
  { q: "kicks off the asynchronous payout reversal", t: "label", label: "consider-alternatives", body: "Consider a synchronous path for tiny amounts to simplify callers." },
  { q: "even if the first response was lost", t: "label", label: "ensure-no-regression", body: "Add a regression test for the lost-response retry path." },
  { q: "multi-capture orders", t: "label", label: "out-of-scope", body: "Out of scope for v0 — agreed, just flagging it." },
  { q: "idempotency_conflict", t: "label", label: "needs-tests", body: "Each error code needs its own test case." },
  { q: "favors correctness over coverage", t: "label", label: "nice-approach", body: "Good principle to state up front." },
  { q: "a request we cannot prove safe is rejected", t: "replace", to: "a request we cannot prove safe is rejected outright", body: "Tiny wording tweak for emphasis." },
  { q: "It is the contract the storefront and the support console both build against", t: "delete", body: "This restates the opening clause — could drop it." },
];

const BACKTEST_ANNOS: Anno[] = [
  { q: "taking meaningfully less drawdown", t: "highlight", body: "The drawdown story is the real selling point — highlighting." },
  { q: "sizing down in high-volatility regimes", t: "comment", body: "Is the vol estimate realized or implied? It changes the lag a lot." },
  { q: "cutting the worst loss roughly in half", t: "thread", body: "Is this net of the cost model, or gross?", replies: ["Net — costs are in.", "Good, then the holdability claim stands."] },
  { q: "next-day open, never the signal-day close", t: "resolved", body: "Confirmed there's no look-ahead here. Resolving." },
  { q: "200 most liquid names, rebalanced monthly", t: "guest", body: "Why 200 and not 500 — where's the liquidity cutoff?" },
  { q: "-12.4%", t: "label", label: "looks-good", body: "Half the benchmark drawdown — strong result." },
  { q: "Sharpe near 1.7", t: "label", label: "verify-this", body: "Verify the frictionless Sharpe — that number looks high." },
  { q: "exits on reversion to the mean or after ten trading days", t: "label", label: "clarify-this", body: "Clarify which exit wins when both trigger on the same day." },
  { q: "two standard deviations from its 20-day mean", t: "label", label: "give-example", body: "One worked entry/exit example would make this concrete." },
  { q: "five basis points per side", t: "label", label: "match-patterns", body: "Match the cost convention used in the other strategy reports." },
  { q: "Position size scales inversely with trailing volatility", t: "label", label: "consider-alternatives", body: "Consider a vol floor so size doesn't blow up in dead-calm markets." },
  { q: "reproducible from the committed config", t: "label", label: "ensure-no-regression", body: "Pin the data snapshot hash so a rerun can't drift." },
  { q: "published by the runner as a fixed snapshot", t: "label", label: "missing-overview", body: "Add the run date and commit near the title." },
  { q: "widen the universe to 500 names", t: "label", label: "out-of-scope", body: "Next-iteration scope — noting it here." },
  { q: "modeled on every fill", t: "label", label: "needs-tests", body: "Add a test asserting costs apply to every fill, not just round-trips." },
  { q: "stands aside entirely in the worst conditions", t: "label", label: "nice-approach", body: "Like the regime-filter direction." },
  { q: "bounds how much weight to put on the headline Sharpe", t: "replace", to: "bounds how much weight to put on the headline Sharpe in isolation", body: "Soften this slightly." },
  { q: "Treat the report as evidence the approach is worth a forward test", t: "delete", body: "Redundant with the caveats above — could cut." },
];

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

  // 3. Docs. doc-access-two-axis S-001: access lives on the share_links axes (the
  //    docs.general_access column is dropped). Each seed doc sets BOTH axes explicitly:
  //    workspace_role=commenter (shared with the workspace) AND link_role=commenter so a
  //    no-account visitor can view AND comment via the /s/<token> capability link (printed below).
  const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

  const seedDoc = async (title: string, slug: string, kind: "markdown" | "html", versions: string[]) => {
    let [doc] = await db.select().from(docsTable).where(eq(docsTable.slug, slug));
    if (!doc) {
      [doc] = await db.insert(docsTable)
        .values({ slug, title, kind, ownerId: demo.id, projectId })
        .returning();
    }
    const rows = await db.select().from(docVersions).where(eq(docVersions.docId, doc!.id));
    const maxV = rows.reduce((m, r) => Math.max(m, r.version), 0);
    for (let v = maxV + 1; v <= versions.length; v++) {
      const content = versions[v - 1]!;
      await db.insert(docVersions).values({
        docId: doc!.id, version: v, content, contentHash: hash(content), publishedBy: demo.id,
        // Mirror the publish path (publish/service.ts): search matches doc_versions.extracted_text,
        // not the raw content — without this the seed docs are invisible to full-text search.
        extractedText: extractText(content, kind),
      });
    }
    // Backfill extracted_text on any pre-existing version that lacks it (rows seeded before the
    // extraction was added). Idempotent: a re-run heals old data without inserting new versions.
    for (const r of rows) {
      if (r.extractedText == null) {
        await db.update(docVersions)
          .set({ extractedText: extractText(r.content, kind) })
          .where(eq(docVersions.id, r.id));
      }
    }
    const [link] = await db.select().from(shareLinks).where(eq(shareLinks.docId, doc!.id));
    if (!link) {
      await db.insert(shareLinks).values({ docId: doc!.id, workspaceRole: "commenter", linkRole: "commenter", capabilityToken: mintCapabilityToken() });
    } else {
      await db.update(shareLinks).set({ workspaceRole: "commenter", linkRole: "commenter", capabilityToken: link.capabilityToken ?? mintCapabilityToken() }).where(eq(shareLinks.docId, doc!.id));
    }
    return doc!.id;
  };

  const refundV1 = await asset("refund-api-spec.md");
  const refundV2 = await asset("refund-api-spec.v2.md");
  const backtestHtml = await asset("strategy-backtest-report.html");

  const mdDocId = await seedDoc("Refund API — v0 Specification", "refund-api-spec", "markdown", [refundV1, refundV2]);
  const htmlDocId = await seedDoc("Strategy Backtest Report", "strategy-backtest-report", "html", [backtestHtml]);

  // 4. Curated annotations on each doc (clear-and-reseed so a re-run refreshes them).
  await seedAnnotations(db, mdDocId, authors, REFUND_ANNOS);
  await seedAnnotations(db, htmlDocId, authors, BACKTEST_ANNOS);

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

/** blockId → whitespace-normalized visible text, as the viewer's locate ladder sees it. */
function blockText(content: string, kind: "html" | "markdown"): { blockId: string; text: string }[] {
  const html = injectBlockIds(renderForAnchoring(content, kind));
  const win = new Window();
  win.document.body.innerHTML = html;
  const out: { blockId: string; text: string }[] = [];
  for (const el of Array.from(win.document.body.querySelectorAll(BLOCK_SELECTOR)) as any[]) {
    const blockId = el.getAttribute("data-block-id") || el.getAttribute("id");
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!blockId || !blockId.startsWith("block-")) continue;
    // Skip containers — anchor to the leaf block that actually holds the phrase.
    if (["ul", "ol", "table", "tr", "pre", "div", "section", "article", "figure", "aside", "nav", "header", "main"].includes(tag)) continue;
    out.push({ blockId, text });
  }
  return out;
}

/** Find the first block whose text contains the phrase; build a precise text-range anchor. */
function anchorForPhrase(blocks: { blockId: string; text: string }[], q: string) {
  for (const b of blocks) {
    const offset = b.text.indexOf(q);
    if (offset < 0) continue;
    return {
      blockId: b.blockId, textSnippet: q, offset, length: q.length,
      prefix: b.text.slice(Math.max(0, offset - 32), offset),
      suffix: b.text.slice(offset + q.length, offset + q.length + 32),
    };
  }
  return null;
}

async function seedAnnotations(db: ReturnType<typeof createDb>["db"], docId: string, authors: string[], entries: Anno[]) {
  await db.delete(annotationsTable).where(eq(annotationsTable.docId, docId)); // comments cascade
  const [v] = await db
    .select({ content: docVersions.content, version: docVersions.version, kind: docsTable.kind })
    .from(docVersions).innerJoin(docsTable, eq(docsTable.id, docVersions.docId))
    .where(eq(docVersions.docId, docId)).orderBy(desc(docVersions.version)).limit(1);
  const blocks = blockText(v!.content, v!.kind as "html" | "markdown");

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

  let placed = 0, missed = 0;
  for (const e of entries) {
    const anchor = anchorForPhrase(blocks, e.q);
    if (!anchor) { console.warn(`  ! phrase not found, skipped: "${e.q}"`); missed++; continue; }
    if (e.t === "guest") {
      const id = await insAnn({ anchor, type: "range", authorId: null });
      await addC(id, null, null, e.body, "Guest Reviewer");
    } else if (e.t === "thread") {
      const a0 = pick(), a1 = pick(), a2 = pick();
      const id = await insAnn({ anchor, type: "range", authorId: a0 });
      const root = await addC(id, null, a0, e.body);
      const reps = e.replies; await addC(id, root, a1, reps[0]!); if (reps[1]) await addC(id, root, a2, reps[1]!);
    } else if (e.t === "resolved") {
      const a = pick(); const id = await insAnn({ anchor, type: "range", authorId: a, status: "resolved" }); await addC(id, null, a, e.body);
    } else if (e.t === "label") {
      const a = pick(); const id = await insAnn({ anchor, type: "range", label: e.label, authorId: a }); await addC(id, null, a, e.body);
    } else if (e.t === "replace") {
      const a = pick(); const id = await insAnn({ anchor, type: "suggestion", authorId: a, suggestion: { kind: "replace", from: e.q, to: e.to, againstVersion: v!.version }, suggestionStatus: "pending" }); await addC(id, null, a, e.body);
    } else if (e.t === "delete") {
      const a = pick(); const id = await insAnn({ anchor, type: "suggestion", authorId: a, suggestion: { kind: "delete", from: e.q, againstVersion: v!.version }, suggestionStatus: "pending" }); await addC(id, null, a, e.body);
    } else {
      const a = pick(); const id = await insAnn({ anchor, type: "range", authorId: a }); await addC(id, null, a, e.body);
    }
    placed++;
  }
  console.log(`  ${docId}: ${placed} annotations placed${missed ? `, ${missed} phrase(s) not found` : ""}`);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
