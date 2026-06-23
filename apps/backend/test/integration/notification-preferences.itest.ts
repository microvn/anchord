// Integration tier (guarded by RUN_INTEGRATION): the notification-preferences feature
// (S-001 table + matrix + API, S-002 delivery) against a REAL Postgres — the tier the unit
// suite deferred (it ran with fakes). What the real DB surfaces that in-memory fakes hide:
//   - the UNIQUE (user_id, type, channel) constraint backing the upsert (PUT same pair twice → 1 row);
//   - the real notification_type / notification_channel pgEnums (a stored override is a real enum row);
//   - the matrix-default effective read against a table with ZERO rows;
//   - the batched real prefs read in delivery (listPreferencesFor → two inArray queries, master switch fold);
//   - the locked/unsupported write refusals enforced at the DB+API boundary (no row stored).
//
// The preferences API is driven over HTTP through createApp({ notifications: { db, prefsRepo, resolveSession } }),
// session-scoped to the actor — two sessions (Alice/Bob) prove caller-scoping (C-005). Delivery is driven by
// calling the real notify dispatch (notifyOnNewFeedback / notifyOnInvited / notifyOnDetached) with a real
// createNotifyRepo(db) + a real MailQueue, then inspecting the notifications table + the queue.
//
// Run: RUN_INTEGRATION=1 bun test ./test/integration/notification-preferences.itest.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  annotations,
  docMembers,
  docs,
  notificationPreferences,
  notifications,
  notificationSettings,
  user,
} from "../../src/db/schema";
import { createApp } from "../../src/app";
import { createDocRepo } from "../../src/publish/repo";
import { createNotifyRepo } from "../../src/notify/repo";
import { createPreferencesRepo } from "../../src/notify/preferences-repo";
import { notifyOnNewFeedback, notifyOnInvited, notifyOnDetached } from "../../src/notify/notify";
import { MailQueue } from "../../src/auth/mail-queue";
import type { SessionResolver } from "../../src/http/auth-gate";
import { withMigratedDb, type MigratedDb } from "./harness";

const RUN = !!process.env.RUN_INTEGRATION;

describe.skipIf(!RUN)("notification preferences — table/API/delivery (real Postgres)", () => {
  let h: MigratedDb;
  // Unique per process so parallel files don't collide.
  const ALICE = `u_pref_alice_${process.pid}`;
  const BOB = `u_pref_bob_${process.pid}`;
  const ALICE_EMAIL = `pref-alice-${process.pid}@example.com`;
  const BOB_EMAIL = `pref-bob-${process.pid}@example.com`;

  beforeAll(async () => {
    h = await withMigratedDb();
    await h.db.insert(user).values([
      { id: ALICE, name: "Alice", email: ALICE_EMAIL, emailVerified: true },
      { id: BOB, name: "Bob", email: BOB_EMAIL, emailVerified: true },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (h) {
      await h.close();
      await h.stop();
    }
  }, 60_000);

  function req(path: string, init: RequestInit = {}) {
    return new Request(`http://localhost${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  }

  // An app whose session resolves to `userId`, with the preferences endpoints wired to a REAL
  // prefsRepo over the test DB. resolveSession is the only fake — the route + repo + table are real.
  function appAs(userId: string) {
    const resolveSession: SessionResolver = async () => ({ userId });
    return createApp({
      dbCheck: async () => {},
      notifications: { db: h.db, prefsRepo: createPreferencesRepo(h.db), resolveSession },
    });
  }

  async function getPrefs(userId: string) {
    const res = await appAs(userId).handle(req("/api/me/notifications/preferences"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    return json.data as {
      preferences: Array<{ type: string; channel: string; supported: boolean; locked: boolean; enabled: boolean }>;
      masterEmailEnabled: boolean;
    };
  }
  function pref(prefs: Awaited<ReturnType<typeof getPrefs>>, type: string, channel: string) {
    return prefs.preferences.find((p) => p.type === type && p.channel === channel)!;
  }

  // notifyOnNewFeedback's recipient set is (doc OWNER ∪ active EDITORS) − actor. The shared doc is
  // owned by ALICE with BOB as an active EDITOR (a doc_members row), so an actor-less dispatch
  // reaches BOTH; an ALICE-actor dispatch reaches only BOB. (Participants/commenters are the
  // thread-activity path, not new_feedback — owner+editor is what this dispatch reads.)
  let docId: string;
  async function seedDoc() {
    if (docId) return docId;
    const slug = `pref-doc-${process.pid}`;
    const created = await createDocRepo(h.db).createDocWithV1({
      slug,
      title: "Pref Doc",
      kind: "html",
      content: "<p>hello</p>",
      contentHash: "pref-hash-v1",
    });
    docId = created.id;
    await h.db.update(docs).set({ ownerId: ALICE }).where(eq(docs.id, docId));
    // BOB is an ACTIVE EDITOR on the doc → a new_feedback recipient (alongside owner ALICE).
    await h.db.insert(docMembers).values({
      docId,
      userId: BOB,
      email: BOB_EMAIL,
      role: "editor",
      status: "active",
      invitedBy: ALICE,
    });
    return docId;
  }
  async function seedAnnotation() {
    const did = await seedDoc();
    const [ann] = await h.db
      .insert(annotations)
      .values({ docId: did, type: "range", anchor: { blockId: "b1", textSnippet: "x", offset: 0, length: 1 } })
      .returning({ id: annotations.id });
    return ann!.id;
  }

  // ── PREFERENCES TABLE + API ────────────────────────────────────────────────

  test("AS-001: a fresh user (no rows) reads every (type,channel) at the matrix default", async () => {
    const prefs = await getPrefs(ALICE);
    // in-app on for ALL types (every matrix in_app default is on/locked-on).
    for (const p of prefs.preferences.filter((p) => p.channel === "in_app")) {
      expect(p.enabled).toBe(true);
    }
    // email on for the high-signal four.
    for (const t of ["new_feedback", "thread_activity", "suggestion_decided", "invited"]) {
      expect(pref(prefs, t, "email").enabled).toBe(true);
    }
    // member_joined email supported but OFF by default (opt-in).
    const mj = pref(prefs, "workspace_member_joined", "email");
    expect(mj.supported).toBe(true);
    expect(mj.enabled).toBe(false);
    // master email on with no settings row.
    expect(prefs.masterEmailEnabled).toBe(true);
    // No rows seeded for Alice yet.
    const rows = await h.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, ALICE));
    expect(rows).toHaveLength(0);
  });

  test("AS-002: PUT override persists; a fresh GET reads it; the UNIQUE key holds (upsert, not duplicate)", async () => {
    const putRes = await appAs(ALICE).handle(
      req("/api/me/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify({ overrides: [{ type: "new_feedback", channel: "email", enabled: false }] }),
      }),
    );
    expect(putRes.status).toBe(200);

    // A fresh request (new app instance) reads the persisted override.
    const prefs = await getPrefs(ALICE);
    expect(pref(prefs, "new_feedback", "email").enabled).toBe(false);
    // Other pairs untouched (still on).
    expect(pref(prefs, "thread_activity", "email").enabled).toBe(true);
    expect(pref(prefs, "new_feedback", "in_app").enabled).toBe(true);

    // PUT the SAME pair again → upsert, still exactly ONE row (the UNIQUE constraint holds).
    const putAgain = await appAs(ALICE).handle(
      req("/api/me/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify({ overrides: [{ type: "new_feedback", channel: "email", enabled: false }] }),
      }),
    );
    expect(putAgain.status).toBe(200);
    const rows = await h.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, ALICE),
          eq(notificationPreferences.type, "new_feedback"),
          eq(notificationPreferences.channel, "email"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  test("AS-003: PUT an UNSUPPORTED channel {detached,email,on} → refused, no row stored", async () => {
    const res = await appAs(ALICE).handle(
      req("/api/me/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify({ overrides: [{ type: "detached", channel: "email", enabled: true }] }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await h.db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, ALICE),
          eq(notificationPreferences.type, "detached"),
          eq(notificationPreferences.channel, "email"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  test("AS-015: PUT a LOCKED in-app disable {detached|workspace_member_removed, in_app, off} → refused, no row", async () => {
    for (const type of ["detached", "workspace_member_removed"]) {
      const res = await appAs(ALICE).handle(
        req("/api/me/notifications/preferences", {
          method: "PUT",
          body: JSON.stringify({ overrides: [{ type, channel: "in_app", enabled: false }] }),
        }),
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      const rows = await h.db
        .select()
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.userId, ALICE),
            eq(notificationPreferences.type, type as any),
            eq(notificationPreferences.channel, "in_app"),
          ),
        );
      expect(rows).toHaveLength(0);
    }
  });

  test("AS-014 / C-005: caller-scoping — Bob never sees Alice's override; Alice's row is keyed to Alice", async () => {
    // Alice already has {new_feedback,email,off} from AS-002. Bob reads → defaults (email on).
    const bob = await getPrefs(BOB);
    expect(pref(bob, "new_feedback", "email").enabled).toBe(true);
    // No row for Bob at all.
    const bobRows = await h.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, BOB));
    expect(bobRows).toHaveLength(0);
    // Alice's stored row is keyed to ALICE's userId.
    const aliceRows = await h.db
      .select({ userId: notificationPreferences.userId, type: notificationPreferences.type })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, ALICE));
    expect(aliceRows.length).toBeGreaterThan(0);
    expect(aliceRows.every((r) => r.userId === ALICE)).toBe(true);
  });

  // ── DELIVERY HONORS PREFS ───────────────────────────────────────────────────

  test("AS-004: email-off override suppresses email for that recipient, not others (in-app still written)", async () => {
    // ALICE (owner) has {new_feedback,email,off} from AS-002 → no email, in-app yes.
    // BOB has defaults → both in-app + email. Make BOB a participant; ALICE is the owner.
    const annId = await seedAnnotation();
    const mail = new MailQueue();
    // Actor is a guest (null) so BOTH Alice (owner) and Bob (editor) are recipients.
    const result = await notifyOnNewFeedback(
      { annotationId: annId, actorUserId: null },
      { repo: createNotifyRepo(h.db), mail, type: "new_feedback" },
    );
    expect(result.recipients.sort()).toEqual([ALICE, BOB].sort());

    const rows = await h.db.select().from(notifications).where(eq(notifications.refId, annId));
    expect(rows.map((r) => r.userId).sort()).toEqual([ALICE, BOB].sort()); // both got in-app
    // Alice email suppressed (override off), Bob email sent (default on) → exactly ONE email.
    expect(mail.statusCounts().pending).toBe(1);
  });

  test("AS-005: master email switch off → in-app row written, NO email for that recipient", async () => {
    // Turn BOB's master switch off via a real settings row (upsert through the repo).
    await createPreferencesRepo(h.db).setMasterEmailEnabled(BOB, false);
    const annId = await seedAnnotation(); // owner ALICE is the actor → only editor BOB remains
    const mail = new MailQueue();
    const result = await notifyOnNewFeedback(
      { annotationId: annId, actorUserId: ALICE }, // ALICE (owner+actor) excluded → only BOB
      { repo: createNotifyRepo(h.db), mail, type: "new_feedback" },
    );
    expect(result.recipients).toEqual([BOB]);
    const rows = await h.db.select().from(notifications).where(eq(notifications.refId, annId));
    expect(rows.map((r) => r.userId)).toEqual([BOB]); // in-app written
    expect(mail.statusCounts().pending).toBe(0); // master off → no email
    // cleanup: restore BOB's master switch for later assertions.
    await createPreferencesRepo(h.db).setMasterEmailEnabled(BOB, true);
  });

  test("AS-006: invited default-on — recipient with default prefs gets in-app AND email (matrix upgrade)", async () => {
    const did = await seedDoc();
    const mail = new MailQueue();
    const result = await notifyOnInvited(
      { refId: did, inviteeUserId: BOB },
      { repo: createNotifyRepo(h.db), mail, type: "invited", appUrl: "http://localhost:3000" },
    );
    expect(result.recipients).toEqual([BOB]);
    const rows = await h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.refId, did), eq(notifications.userId, BOB), eq(notifications.type, "invited")));
    expect(rows).toHaveLength(1); // in-app row
    expect(mail.statusCounts().pending).toBe(1); // email — invited gains email by default
  });

  test("AS-007: critical locked at delivery — detached writes the in-app row even attempting a disable", async () => {
    // Try (and fail) to disable BOB's detached in_app at the write boundary; then deliver detached.
    const refused = await appAs(BOB).handle(
      req("/api/me/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify({ overrides: [{ type: "detached", channel: "in_app", enabled: false }] }),
      }),
    );
    expect(refused.status).toBeGreaterThanOrEqual(400); // locked write refused

    const did = await seedDoc();
    const mail = new MailQueue();
    const result = await notifyOnDetached(
      { refId: did, authors: [{ authorId: BOB, count: 2 }] },
      { repo: createNotifyRepo(h.db), mail, type: "detached" },
    );
    expect(result.recipients).toEqual([BOB]);
    const rows = await h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.refId, did), eq(notifications.userId, BOB), eq(notifications.type, "detached")));
    expect(rows.length).toBeGreaterThanOrEqual(1); // always-deliver set forced the in-app row
    expect(mail.statusCounts().pending).toBe(0); // detached is in-app only (low-signal)
  });

  test("AS-013: prefs read throws → email fails CLOSED, in-app fails OPEN (in-app row still written)", async () => {
    // A thin wrapper over the REAL repo whose ONLY change is a throwing listPreferencesFor — the
    // insert + in-app path stays real (real DB write). This is the documented fail-safe seam.
    const realRepo = createNotifyRepo(h.db);
    const throwingRepo = {
      ...realRepo,
      listPreferencesFor: async () => {
        throw new Error("simulated prefs-read failure");
      },
    };
    const annId = await seedAnnotation();
    const mail = new MailQueue();
    const result = await notifyOnNewFeedback(
      { annotationId: annId, actorUserId: ALICE }, // owner ALICE excluded (actor) → recipient BOB
      { repo: throwingRepo, mail, type: "new_feedback" },
    );
    expect(result.recipients).toEqual([BOB]);
    const rows = await h.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.refId, annId), eq(notifications.userId, BOB)));
    expect(rows).toHaveLength(1); // in-app fails OPEN — row written via the REAL insert path
    expect(mail.statusCounts().pending).toBe(0); // email fails CLOSED — nothing enqueued
  });
});
