// Demo activity seed for UI review (workspace-activity). Mirrors Anchord-Design/activity-data.jsx:
// 15 events across 3 day-groups, ALL 12 event types, multiple actors, with quote/body/meta so the
// feed renders the prototype's rich rows. Idempotent: clears the demo workspace's activity first.
//   Run: bun src/db/seed-activity-demo.ts
import { eq, and, inArray } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { docs, docVersions, projects, shareLinks, activity, user as userTable, workspaceMembers } from "./schema";

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql);
const WS = "327001415203422208";

const [demo] = await db.select().from(userTable).where(eq(userTable.email, "demo@anchord.test"));
if (!demo) throw new Error("demo user missing — run bun db:seed first");

// ── projects (render-publish / web-core / annotation-core) ──────────────────
async function ensureProject(name: string): Promise<string> {
  const [ex] = await db.select().from(projects).where(and(eq(projects.workspaceId, WS), eq(projects.name, name)));
  if (ex) return ex.id;
  const [p] = await db.insert(projects).values({ workspaceId: WS, name, isDefault: false }).returning();
  return p!.id;
}
const projRenderPublish = await ensureProject("render-publish");
const projWebCore = await ensureProject("web-core");
const projAnnoCore = await ensureProject("annotation-core");

// ── docs (prototype titles), anyone_in_workspace + a share_links role so a member sees them too ──
async function ensureDoc(slug: string, title: string, projectId: string): Promise<string> {
  const [ex] = await db.select().from(docs).where(eq(docs.slug, slug));
  const id = ex
    ? (await db.update(docs).set({ title, projectId, generalAccess: "anyone_in_workspace" }).where(eq(docs.id, ex.id)), ex.id)
    : (await db.insert(docs).values({ slug, title, kind: "markdown", ownerId: demo.id, projectId, generalAccess: "anyone_in_workspace" }).returning())[0]!.id;
  const [sl] = await db.select().from(shareLinks).where(eq(shareLinks.docId, id));
  if (sl) await db.update(shareLinks).set({ role: "commenter" }).where(eq(shareLinks.docId, id));
  else await db.insert(shareLinks).values({ docId: id, role: "commenter" });
  return id;
}
const docRfc = await ensureDoc("rp-pipeline-rfc", "Render + publish pipeline RFC", projRenderPublish);
const docWebCore = await ensureDoc("web-core-contract", "Web-core behavior contract", projWebCore);
const docDiff = await ensureDoc("diff-viewer-mockups", "Diff viewer mockups", projRenderPublish);
const docAnno = await ensureDoc("annotation-data-model", "Annotation data model", projAnnoCore);
const docAuth = await ensureDoc("auth-invite-flows", "Auth & invite flows", projWebCore);

// two versions on the RFC so a publish event's detail renders a real diff
async function ensureVersion(docId: string, version: number, content: string) {
  const [ex] = await db.select().from(docVersions).where(and(eq(docVersions.docId, docId), eq(docVersions.version, version)));
  if (!ex) await db.insert(docVersions).values({ docId, version, content, contentHash: Bun.hash(content).toString(16) });
}
await ensureVersion(docRfc, 1, "# Render + publish pipeline\n\nThe renderer reads the published version.\nSanitization happens at storage time.\n");
await ensureVersion(docRfc, 2, "# Render + publish pipeline\n\nThe renderer reads the published version.\nSanitization happens at storage time.\nNew: a sandbox bridge + postMessage relay contract.\nThe relay forwards annotations to the parent.\n");

// ── clear + reseed the demo workspace's activity ────────────────────────────
await db.delete(activity).where(eq(activity.workspaceId, WS));

// time helpers (a normal bun script — real Date is fine here)
const now = Date.now();
const mins = (m: number) => new Date(now - m * 60_000);
const days = (d: number, m = 0) => new Date(now - d * 86_400_000 - m * 60_000);

type Row = Parameters<typeof db.insert>[0] extends never ? never : typeof activity.$inferInsert;
const human = (name: string) => ({ actorUserId: demo.id, actorName: name });
const SYSTEM = { actorUserId: null, actorName: "System" };

const rows: Row[] = [
  // ── Today ──
  { workspaceId: WS, type: "comment", ...human("Devin Osei"), docId: docRfc, projectId: projRenderPublish,
    summary: "commented on", target: "§ Sanitization",
    meta: { body: "Should we sanitize before the render step or after? Doing it after means the renderer sees raw model output — that feels backwards.", quote: "All AI-generated HTML is sanitized server-side before storage.", thread: "open", replies: 1 }, createdAt: mins(18) },
  { workspaceId: WS, type: "reply", ...human("Mara Lindqvist"), docId: docRfc, projectId: projRenderPublish,
    summary: "replied to", target: "Devin’s thread",
    meta: { body: "Before. The renderer should never touch unsanitized output — I’ll make that explicit in v3.", thread: "open" }, createdAt: mins(12) },
  { workspaceId: WS, type: "publish", ...human("Mara Lindqvist"), docId: docWebCore, projectId: projWebCore,
    summary: "published", target: "v4",
    meta: { from: 3, to: 4, adds: 5, dels: 2, body: "Rewrote the overview and S-001; clarified the bootstrap + existence-hiding contract." }, createdAt: mins(30) },
  { workspaceId: WS, type: "resolve", ...human("Mara Lindqvist"), docId: docWebCore, projectId: projWebCore,
    summary: "resolved a thread on", target: "§ S-003 · Admin gating",
    meta: { body: "Confirmed the last-admin invariant is enforced in the mutation guard, not just the UI.", quote: "The last-admin invariant blocks demoting or removing the final admin of a workspace.", thread: "resolved" }, createdAt: mins(48) },
  { workspaceId: WS, type: "detached", ...SYSTEM, docId: docRfc, projectId: projRenderPublish,
    summary: "detached 2 annotations on", target: "re-anchor after v2",
    meta: { count: 2, body: "Two annotations could not be re-anchored after the latest publish and were moved to the detached list." }, createdAt: mins(33) },
  { workspaceId: WS, type: "workspace_renamed", ...human("Mara Lindqvist"),
    summary: "renamed the workspace to", target: "Acme Platform",
    meta: { body: "Workspace renamed from “Demo User's workspace” to “Acme Platform”." }, createdAt: mins(50) },
  { workspaceId: WS, type: "member", ...human("Priya Nair"),
    summary: "accepted an invite to", target: "Acme Platform",
    meta: { role: "member", body: "Priya Nair joined the workspace as a member." }, createdAt: mins(65) },

  // ── Yesterday ──
  { workspaceId: WS, type: "share", ...human("Devin Osei"), docId: docDiff, projectId: projRenderPublish,
    summary: "changed sharing on", target: "Diff viewer mockups",
    meta: { access: "Anyone with link", role: "commenter", body: "Set general access to “Anyone with link” (commenter) and enabled guest commenting." }, createdAt: days(1, 100) },
  { workspaceId: WS, type: "comment", ...human("Tom Becker"), docId: docDiff, projectId: projRenderPublish,
    summary: "commented on", target: "frame 3",
    meta: { body: "The stacked layout at ≤760 should keep the source line-diff horizontally scrollable — right now it wraps.", thread: "open" }, createdAt: days(1, 220) },
  { workspaceId: WS, type: "publish", ...human("Devin Osei"), docId: docRfc, projectId: projRenderPublish, versionId: null,
    summary: "published", target: "v2",
    meta: { from: 1, to: 2, adds: 11, dels: 0, body: "Added the sandbox bridge section and the postMessage relay contract." }, createdAt: days(1, 380) },
  { workspaceId: WS, type: "restore", ...human("Mara Lindqvist"), docId: docAnno, projectId: projAnnoCore,
    summary: "restored", target: "v1 as v2",
    meta: { restored: 1, as: 2, body: "Reverted the schema change — restored v1 as a new version (v2). History is append-only, so nothing was lost." }, createdAt: days(1, 470) },
  { workspaceId: WS, type: "member_removed", ...human("Devin Osei"),
    summary: "removed", target: "Tom Becker",
    meta: { body: "Removed Tom Becker from the workspace." }, createdAt: days(1, 520) },

  // ── 3 days ago ──
  { workspaceId: WS, type: "invite", ...human("Mara Lindqvist"),
    summary: "invited", target: "sven@acme.dev",
    meta: { role: "member", pending: true, body: "Sent a workspace invite to sven@acme.dev as a member. Pending until they sign up." }, createdAt: days(3, 100) },
  { workspaceId: WS, type: "project", ...human("Mara Lindqvist"), projectId: projAnnoCore,
    summary: "created project", target: "annotation-core",
    meta: { body: "New project created to group annotation-core specs and plans." }, createdAt: days(3, 140) },
  { workspaceId: WS, type: "comment", ...human("Priya Nair"), docId: docAuth, projectId: projWebCore,
    summary: "commented on", target: "§ OAuth",
    meta: { body: "Do we redirect to the original deep link after OAuth, or always to the dashboard? Should preserve intent.", thread: "resolved" }, createdAt: days(3, 300) },
];

await db.insert(activity).values(rows);

// make sure the member can preview too (Tom is in the workspace; demo is admin)
console.log(`seeded ${rows.length} activity events into workspace ${WS}`);
console.log("types:", [...new Set(rows.map((r) => r.type))].sort().join(", "));
await sql.end({ timeout: 5 });
