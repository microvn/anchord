// In-process route tests for the in-app notification READ surface (notifications-email S-006).
// HTTP GLUE only — envelope + session gate + pagination over an in-memory NotificationReadRepo
// that enforces the same (userId)-scoping the Drizzle repo does, so the read-own-only + mark
// no-op semantics are exercised through app.handle without a real Postgres.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { NotificationReadRepo, NotificationRow } from "../../src/notify/read-repo";

const asUser = (userId: string): SessionResolver => async () => ({ userId });
const noSession: SessionResolver = async () => null;

type Stored = NotificationRow & { userId: string };

// In-memory repo that mirrors the Drizzle repo's (userId)-scoped contract: a mark targeting a row
// that isn't the caller's matches nothing (no-op), and read only moves false→true.
function memRepo(rows: Stored[]): NotificationReadRepo {
  const byUser = (uid: string) =>
    rows
      .filter((r) => r.userId === uid)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  return {
    async countForUser(uid) {
      return byUser(uid).length;
    },
    async listForUser(uid, { offset, limit }) {
      return byUser(uid).slice(offset, offset + limit);
    },
    async countUnreadForUser(uid) {
      return byUser(uid).filter((r) => !r.read).length;
    },
    async markRead(uid, id) {
      const row = rows.find((r) => r.userId === uid && r.id === id);
      if (row) row.read = true; // foreign id → not found → no-op (AS-017)
    },
    async markAllRead(uid) {
      let n = 0;
      for (const r of rows) {
        if (r.userId === uid && !r.read) {
          r.read = true;
          n++;
        }
      }
      return n;
    },
  };
}

function buildApp(resolveSession: SessionResolver, rows: Stored[]) {
  return createApp({ dbCheck: async () => {}, notifications: { repo: memRepo(rows), resolveSession } });
}

function req(method: string, path: string) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
  });
}

// Build N rows for a user with strictly increasing timestamps (so newest-first is deterministic).
function rowsFor(userId: string, n: number, opts: { read?: boolean } = {}): Stored[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${userId}-n${String(i).padStart(3, "0")}`,
    userId,
    type: "thread_activity" as const,
    refId: `${userId}-ref${i}`,
    read: opts.read ?? false,
    createdAt: new Date(2026, 0, 1, 0, 0, i), // ascending; index n999 is newest
    slug: `${userId}-doc-${i}`,
    docTitle: null,
    actorName: null,
    snippet: null,
  }));
}

describe("/api/me/notifications route glue (notifications-email S-006)", () => {
  test("AS-012.T1: list returns only the caller's rows, newest-first — none of another user's", async () => {
    const bob = rowsFor("bob", 3);
    const carol = rowsFor("carol", 2);
    const app = buildApp(asUser("bob"), [...bob, ...carol]);
    const res = await app.handle(req("GET", "/api/me/notifications"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    const items = json.data.items as NotificationRow[];
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.id.startsWith("bob"))).toBe(true);
    // newest-first: the highest-index (latest createdAt) row leads.
    expect(items[0].id).toBe("bob-n002");
    expect(items[2].id).toBe("bob-n000");
  });

  test("AS-014.T2: each row carries refId + slug so the client can build /d/:slug#annotation-:refId", async () => {
    const app = buildApp(asUser("bob"), rowsFor("bob", 1));
    const json = (await (await app.handle(req("GET", "/api/me/notifications"))).json()) as any;
    const row = json.data.items[0] as NotificationRow;
    expect(row.refId).toBe("bob-ref0");
    expect(row.slug).toBe("bob-doc-0"); // deep-link target → /d/bob-doc-0#annotation-bob-ref0
  });

  test("AS-012.T2: bounded page (limit 20) + total/hasNext summary; 21st row → hasNext true", async () => {
    const app = buildApp(asUser("bob"), rowsFor("bob", 25));
    const res = await app.handle(req("GET", "/api/me/notifications"));
    const json = (await res.json()) as any;
    expect(json.data.items).toHaveLength(20); // default page size
    expect(json.data.pagination.total).toBe(25);
    expect(json.data.pagination.limit).toBe(20);
    expect(json.data.pagination.hasNext).toBe(true); // a 21st row exists → more pages
    // page 2 carries the remaining 5.
    const res2 = await app.handle(req("GET", "/api/me/notifications?page=2"));
    const json2 = (await res2.json()) as any;
    expect(json2.data.items).toHaveLength(5);
    expect(json2.data.pagination.hasNext).toBe(false);
  });

  test("AS-012.T2 edge: limit over the cap is clamped to 50, not rejected", async () => {
    const app = buildApp(asUser("bob"), rowsFor("bob", 60));
    const res = await app.handle(req("GET", "/api/me/notifications?limit=999"));
    const json = (await res.json()) as any;
    expect(json.data.pagination.limit).toBe(50); // clamped to maxLimit
    expect(json.data.items).toHaveLength(50);
  });

  test("AS-012.T2 edge: page below 1 → 400 VALIDATION_ERROR (a client bug, not coerced)", async () => {
    const app = buildApp(asUser("bob"), rowsFor("bob", 3));
    const res = await app.handle(req("GET", "/api/me/notifications?page=0"));
    expect(res.status).toBe(400);
  });

  test("AS-013: unread count reflects the caller's unread rows (3 unread + 7 read → 3)", async () => {
    const unread = rowsFor("bob", 3, { read: false });
    const read = rowsFor("bob", 7, { read: true }).map((r) => ({ ...r, id: `r-${r.id}` }));
    const app = buildApp(asUser("bob"), [...unread, ...read]);
    const res = await app.handle(req("GET", "/api/me/notifications/unread-count"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.count).toBe(3);
  });

  test("AS-014.T1: marking ONE unread row flips only it; the badge decrements", async () => {
    const rows = rowsFor("bob", 3, { read: false });
    const app = buildApp(asUser("bob"), rows);
    const before = (await (await app.handle(req("GET", "/api/me/notifications/unread-count"))).json()) as any;
    expect(before.data.count).toBe(3);

    const target = rows[1].id;
    const mark = await app.handle(req("POST", `/api/me/notifications/${target}/read`));
    expect(mark.status).toBe(200);
    expect(((await mark.json()) as any).data.read).toBe(true);

    const after = (await (await app.handle(req("GET", "/api/me/notifications/unread-count"))).json()) as any;
    expect(after.data.count).toBe(2); // exactly one decrement — the other two stay unread
    expect(rows.find((r) => r.id === target)!.read).toBe(true);
    expect(rows.filter((r) => !r.read)).toHaveLength(2);
  });

  test("AS-015: mark-all-read clears every unread row for the caller", async () => {
    const rows = rowsFor("bob", 4, { read: false });
    const app = buildApp(asUser("bob"), rows);
    const res = await app.handle(req("POST", "/api/me/notifications/read-all"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.marked).toBe(4);
    const after = (await (await app.handle(req("GET", "/api/me/notifications/unread-count"))).json()) as any;
    expect(after.data.count).toBe(0);
  });

  test("AS-016: a user with zero notifications gets an empty page + zero unread", async () => {
    const app = buildApp(asUser("bob"), []);
    const list = (await (await app.handle(req("GET", "/api/me/notifications"))).json()) as any;
    expect(list.data.items).toHaveLength(0);
    expect(list.data.pagination.total).toBe(0);
    const count = (await (await app.handle(req("GET", "/api/me/notifications/unread-count"))).json()) as any;
    expect(count.data.count).toBe(0);
  });

  test("AS-017 / C-008: Bob cannot read or mark Carol's row — it never appears and the mark is a no-op", async () => {
    const carol = rowsFor("carol", 1, { read: false });
    const app = buildApp(asUser("bob"), [...rowsFor("bob", 1), ...carol]);
    // Carol's row never appears in Bob's list.
    const list = (await (await app.handle(req("GET", "/api/me/notifications"))).json()) as any;
    expect((list.data.items as NotificationRow[]).every((i) => i.id.startsWith("bob"))).toBe(true);
    // Bob marking Carol's row read → 200 (no existence leak), but Carol's row is unchanged.
    const carolId = carol[0].id;
    const mark = await app.handle(req("POST", `/api/me/notifications/${carolId}/read`));
    expect(mark.status).toBe(200); // NOT a 403 — existence-hiding no-op (AS-017)
    expect(carol[0].read).toBe(false); // still unread — Bob's mark didn't touch it
  });

  test("AS-018 / C-010: marking an already-read row, then read-all with nothing unread, are idempotent no-ops", async () => {
    const rows = rowsFor("bob", 2, { read: true }); // all already read
    const app = buildApp(asUser("bob"), rows);
    // Click an already-read row → 200, still read (monotonic, no flip-back).
    const r1 = await app.handle(req("POST", `/api/me/notifications/${rows[0].id}/read`));
    expect(r1.status).toBe(200);
    expect(rows[0].read).toBe(true);
    // mark-all with nothing unread → 0 marked.
    const all = await app.handle(req("POST", "/api/me/notifications/read-all"));
    expect(((await all.json()) as any).data.marked).toBe(0);
    expect(rows.every((r) => r.read)).toBe(true);
  });

  test("C-009: opening the bell does NOT clear unread — a list read leaves the count unchanged", async () => {
    const app = buildApp(asUser("bob"), rowsFor("bob", 3, { read: false }));
    await app.handle(req("GET", "/api/me/notifications")); // "open the bell"
    const after = (await (await app.handle(req("GET", "/api/me/notifications/unread-count"))).json()) as any;
    expect(after.data.count).toBe(3); // listing did not mark anything read
  });

  test("no session → 401 on every endpoint", async () => {
    const app = buildApp(noSession, []);
    expect((await app.handle(req("GET", "/api/me/notifications"))).status).toBe(401);
    expect((await app.handle(req("GET", "/api/me/notifications/unread-count"))).status).toBe(401);
    expect((await app.handle(req("POST", "/api/me/notifications/x/read"))).status).toBe(401);
    expect((await app.handle(req("POST", "/api/me/notifications/read-all"))).status).toBe(401);
  });
});
