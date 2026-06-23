import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { notificationsRoutes } from "./notifications";
import type { NotificationReadRepo } from "../notify/read-repo";
import type { PreferencesRepo } from "../notify/preferences-repo";
import type {
  EffectivePreference,
  NotificationChannel,
  PreferenceOverride,
} from "../notify/preferences-matrix";
import type { NotificationType } from "../notify/types";
import type { Actor } from "../http/auth-gate";

// notification-preferences S-001 — the preferences READ/WRITE surface on /api/me/notifications/
// preferences, driven through the real Elysia route with an INJECTED fake repo + fake session
// resolver (no DB). Proves the route contract: a fresh user reads matrix defaults; an override
// persists; an unsupported/locked write is refused and stores NO row; and every read/write is
// scoped to the SESSION user, never a body/path userId (C-005, AS-014).

// An in-memory PreferencesRepo keyed by userId — so a cross-user test proves isolation.
function makeFakePrefsRepo() {
  const overrides = new Map<string, PreferenceOverride[]>();
  const master = new Map<string, boolean>();
  const repo: PreferencesRepo = {
    async listOverrides(userId) {
      return [...(overrides.get(userId) ?? [])];
    },
    async getMasterEmailEnabled(userId) {
      return master.get(userId) ?? true;
    },
    async setOverride(userId, type, channel, enabled) {
      const list = overrides.get(userId) ?? [];
      const idx = list.findIndex((o) => o.type === type && o.channel === channel);
      if (idx >= 0) list[idx] = { type, channel, enabled };
      else list.push({ type, channel, enabled });
      overrides.set(userId, list);
    },
    async setMasterEmailEnabled(userId, enabled) {
      master.set(userId, enabled);
    },
  };
  return { repo, overrides, master };
}

// A read repo stub — unused by the preferences endpoints, present to satisfy the route deps.
const readRepoStub: NotificationReadRepo = {
  async countForUser() {
    return 0;
  },
  async listForUser() {
    return [];
  },
  async countUnreadForUser() {
    return 0;
  },
  async markRead() {},
  async markAllRead() {
    return 0;
  },
};

// Build the app resolving the session to a FIXED actor (the "logged-in" user). The handler reads
// userId ONLY from this actor — there is no way to pass a userId in the body/path.
function appFor(sessionUserId: string, prefsRepo: PreferencesRepo) {
  const resolveSession = async (): Promise<Actor | null> => ({ userId: sessionUserId });
  return new Elysia().use(
    notificationsRoutes({ repo: readRepoStub, prefsRepo, resolveSession }),
  );
}

function getPrefs(app: ReturnType<typeof appFor>) {
  return app.handle(
    new Request("http://localhost/api/me/notifications/preferences", { method: "GET" }),
  );
}

function putPrefs(app: ReturnType<typeof appFor>, body: unknown) {
  return app.handle(
    new Request("http://localhost/api/me/notifications/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface PrefsPayload {
  preferences: EffectivePreference[];
  masterEmailEnabled: boolean;
}
function find(prefs: EffectivePreference[], type: NotificationType, channel: NotificationChannel) {
  return prefs.find((p) => p.type === type && p.channel === channel)!;
}

test("AS-001: a fresh user reads every preference at its matrix default + master email on", async () => {
  const { repo } = makeFakePrefsRepo();
  const res = await getPrefs(appFor("alice", repo));
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: PrefsPayload };
  expect(data.masterEmailEnabled).toBe(true);
  // in-app on for every event (spot-check a few), email on for high-signal, off for member_joined.
  expect(find(data.preferences, "new_feedback", "in_app").enabled).toBe(true);
  expect(find(data.preferences, "new_feedback", "email").enabled).toBe(true);
  expect(find(data.preferences, "invited", "email").enabled).toBe(true);
  expect(find(data.preferences, "workspace_member_joined", "email").enabled).toBe(false);
  expect(find(data.preferences, "detached", "email").supported).toBe(false);
});

test("AS-002: an override {new_feedback,email,off} persists across a re-read; other prefs stay on", async () => {
  const { repo } = makeFakePrefsRepo();
  const app = appFor("alice", repo);
  const put = await putPrefs(app, {
    overrides: [{ type: "new_feedback", channel: "email", enabled: false }],
  });
  expect(put.status).toBe(200);

  // Re-read in a "later session" (a fresh handler over the SAME repo).
  const res = await getPrefs(appFor("alice", repo));
  const { data } = (await res.json()) as { data: PrefsPayload };
  expect(find(data.preferences, "new_feedback", "email").enabled).toBe(false);
  expect(find(data.preferences, "new_feedback", "in_app").enabled).toBe(true);
  expect(find(data.preferences, "thread_activity", "email").enabled).toBe(true);
});

test("AS-003: an unsupported channel {detached,email} is refused (400) and stores NO row", async () => {
  const { repo, overrides } = makeFakePrefsRepo();
  const res = await putPrefs(appFor("alice", repo), {
    overrides: [{ type: "detached", channel: "email", enabled: true }],
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(body.error.message).toContain("unsupported channel");
  // No row was stored — the refusal is total.
  expect(overrides.get("alice") ?? []).toHaveLength(0);
});

test("AS-015: a LOCKED disable {detached,in_app,off} is refused and stores NO row", async () => {
  const { repo, overrides } = makeFakePrefsRepo();
  const res = await putPrefs(appFor("alice", repo), {
    overrides: [{ type: "detached", channel: "in_app", enabled: false }],
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { message: string } };
  expect(body.error.message).toContain("locked");
  expect(overrides.get("alice") ?? []).toHaveLength(0);
});

test("AS-015: a LOCKED disable {workspace_member_removed,in_app,off} is refused (no row)", async () => {
  const { repo, overrides } = makeFakePrefsRepo();
  const res = await putPrefs(appFor("alice", repo), {
    overrides: [{ type: "workspace_member_removed", channel: "in_app", enabled: false }],
  });
  expect(res.status).toBe(400);
  expect(overrides.get("alice") ?? []).toHaveLength(0);
});

test("AS-003/AS-015: a batch with one bad pair rejects the WHOLE batch — no partial write", async () => {
  const { repo, overrides } = makeFakePrefsRepo();
  const res = await putPrefs(appFor("alice", repo), {
    overrides: [
      { type: "new_feedback", channel: "email", enabled: false }, // valid
      { type: "detached", channel: "in_app", enabled: false }, // locked → refused
    ],
  });
  expect(res.status).toBe(400);
  // The valid pair was NOT applied — validation runs before any write.
  expect(overrides.get("alice") ?? []).toHaveLength(0);
});

test("C-005 / AS-014: reads/writes are scoped to the SESSION user — Alice cannot touch Bob's prefs", async () => {
  const { repo, overrides, master } = makeFakePrefsRepo();
  // Bob has an existing override + master email off.
  await repo.setOverride("bob", "new_feedback", "email", false);
  await repo.setMasterEmailEnabled("bob", false);

  // Alice writes (her session). The body carries NO userId — there is no field for it; even if a
  // client tried, the schema strips unknown keys and userId comes only from the session actor.
  const aliceApp = appFor("alice", repo);
  const put = await putPrefs(aliceApp, {
    overrides: [{ type: "thread_activity", channel: "email", enabled: false }],
    // a forged target — must be ignored (stripped; userId derives from session)
    userId: "bob",
  } as unknown);
  expect(put.status).toBe(200);

  // Alice's write landed under "alice", not "bob".
  expect(overrides.get("alice")).toEqual([
    { type: "thread_activity", channel: "email", enabled: false },
  ]);
  // Bob's rows are untouched.
  expect(overrides.get("bob")).toEqual([
    { type: "new_feedback", channel: "email", enabled: false },
  ]);
  expect(master.get("bob")).toBe(false);

  // Alice's READ returns ONLY Alice's effective prefs (master still on; her one override applied).
  const res = await getPrefs(aliceApp);
  const { data } = (await res.json()) as { data: PrefsPayload };
  expect(data.masterEmailEnabled).toBe(true); // Alice's own, not Bob's off
  expect(find(data.preferences, "thread_activity", "email").enabled).toBe(false);
  expect(find(data.preferences, "new_feedback", "email").enabled).toBe(true); // Bob's override never bleeds in
});

test("master email switch persists and is surfaced on read (S-001 stores/reads it; S-002 enforces)", async () => {
  const { repo } = makeFakePrefsRepo();
  const app = appFor("alice", repo);
  const put = await putPrefs(app, { masterEmailEnabled: false });
  expect(put.status).toBe(200);
  const { data } = (await put.json()) as { data: PrefsPayload };
  expect(data.masterEmailEnabled).toBe(false);
  // Per-pair values are NOT mutated by the master switch (F6 — master applies at delivery, S-002).
  expect(find(data.preferences, "new_feedback", "email").enabled).toBe(true);
});

test("an empty write body is rejected (no override and no master switch)", async () => {
  const { repo } = makeFakePrefsRepo();
  const res = await putPrefs(appFor("alice", repo), {});
  expect(res.status).toBe(400);
});

test("a write for an unknown type is rejected at the schema boundary", async () => {
  const { repo, overrides } = makeFakePrefsRepo();
  const res = await putPrefs(appFor("alice", repo), {
    overrides: [{ type: "made_up_type", channel: "in_app", enabled: true }],
  });
  expect(res.status).toBe(400);
  expect(overrides.get("alice") ?? []).toHaveLength(0);
});
