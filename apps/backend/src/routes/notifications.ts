// HTTP route mount for the in-app notification READ surface (notifications-email S-006).
//
// USER-scoped, NOT workspace-scoped — a notification is personal (C-008): the gate is
// requireSession + actor.userId alone, never a /api/w/:workspaceId path. The earlier
// stories WRITE rows into the notifications table; this reads them back for the bell.
//
// Contract (all under /api/me/notifications, all session-gated, all scoped WHERE userId = actor.userId):
//   GET    /api/me/notifications?page=&limit=   → 200 { items, pagination }  recent-first (AS-012)
//   GET    /api/me/notifications/unread-count    → 200 { count }              (AS-013)
//   POST   /api/me/notifications/:id/read        → 200 { read: true }         mark ONE read (AS-014/C-009)
//   POST   /api/me/notifications/read-all        → 200 { marked }             mark all read (AS-015)
//
// C-008 READ-OWN-ONLY: every read + every mark is scoped to actor.userId. A cross-user mark is
// a NO-OP (the WHERE clause matches no row), never a 403 that would leak the row's existence
// (AS-017). C-010 idempotency: marking an already-read row, or read-all with nothing unread, is a
// no-op; `read` is monotonic to true (last-write-wins) — re-marking never flips it back.

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { validateBody } from "../http/validate";
import { ValidationError } from "../http/errors";
import { paginationQuery, paginate, type PaginationParams } from "../http/pagination";
import { createNotificationReadRepo, type NotificationReadRepo } from "../notify/read-repo";
import { createPreferencesRepo, type PreferencesRepo } from "../notify/preferences-repo";
import {
  ALL_CHANNELS,
  effectivePreferences,
  rejectWrite,
  type NotificationChannel,
} from "../notify/preferences-matrix";
import type { NotificationType } from "../notify/types";
import type { DB } from "../db/client";

// The notification types the preferences API accepts — mirrors the notification_type enum
// (NotificationType). A change for an unknown type is refused at the schema boundary (400).
const PREF_TYPES: readonly NotificationType[] = [
  "reply",
  "new_feedback",
  "thread_activity",
  "suggestion_decided",
  "resolved",
  "detached",
  "invited",
  "workspace_invited",
  "workspace_member_joined",
  "workspace_member_removed",
  "workspace_renamed",
];

// One preference override the WRITE endpoint accepts. The matrix (not Zod) decides whether the
// pair is supported/locked — Zod only guards the shape + the enum membership.
const prefOverrideSchema = z.object({
  type: z.enum(PREF_TYPES as [NotificationType, ...NotificationType[]]),
  channel: z.enum(ALL_CHANNELS as unknown as [NotificationChannel, ...NotificationChannel[]]),
  enabled: z.boolean(),
});

// The write body: a batch of one-or-more overrides, and/or the master email switch. At least one
// of the two must be present (an empty body is a no-op the schema rejects).
const prefWriteSchema = z
  .object({
    overrides: z.array(prefOverrideSchema).optional(),
    masterEmailEnabled: z.boolean().optional(),
  })
  .refine((b) => (b.overrides && b.overrides.length > 0) || b.masterEmailEnabled !== undefined, {
    message: "provide at least one override or masterEmailEnabled",
  });

// Bell page size: default 20, cap 50 (the recent-N surface — no infinite scroll in v0).
const notificationsPage = paginationQuery({ defaultLimit: 20, maxLimit: 50 });

export interface NotificationsRoutesDeps {
  db?: DB;
  /** Pre-built read repo (tests). Wins over `db`. */
  repo?: NotificationReadRepo;
  /** Pre-built preferences repo (tests). Wins over `db`. */
  prefsRepo?: PreferencesRepo;
  resolveSession: SessionResolver;
}

export function notificationsRoutes(deps: NotificationsRoutesDeps) {
  const repo: NotificationReadRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("notificationsRoutes requires either `repo` or `db`");
      return createNotificationReadRepo(deps.db);
    })();
  // prefsRepo is LAZY: only the preferences endpoints need it. The read endpoints (list /
  // unread-count / mark-read / read-all) work with just `repo`, so constructing the routes with
  // neither `prefsRepo` nor `db` must NOT throw — it only fails if a preferences handler runs
  // without a resolvable repo. (Mirrors how `repo` is local to the read endpoints.)
  let cachedPrefsRepo: PreferencesRepo | undefined = deps.prefsRepo;
  const getPrefsRepo = (): PreferencesRepo => {
    if (cachedPrefsRepo) return cachedPrefsRepo;
    if (!deps.db) throw new Error("notificationsRoutes requires either `prefsRepo` or `db`");
    cachedPrefsRepo = createPreferencesRepo(deps.db);
    return cachedPrefsRepo;
  };

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    // GET /api/me/notifications — the caller's recent notifications, newest-first, paginated.
    // C-008: only rows WHERE user_id = actor.userId — another user's rows never appear (AS-012/AS-017).
    .get("/api/me/notifications", async ({ query, actor }) => {
      const page = notificationsPage.parse(query) as PaginationParams;
      const total = await repo.countForUser(actor.userId);
      const items = await repo.listForUser(actor.userId, {
        offset: (page.page - 1) * page.limit,
        limit: page.limit,
      });
      return paginate(items, { page: page.page, limit: page.limit, total });
    })
    // GET /api/me/notifications/unread-count — how many of the caller's rows are unread (AS-013).
    .get("/api/me/notifications/unread-count", async ({ actor }) => {
      const count = await repo.countUnreadForUser(actor.userId);
      return { count };
    })
    // POST /api/me/notifications/:id/read — mark ONE row read. Scoped to actor.userId, so marking
    // a row that is not the caller's matches nothing → no-op (AS-017), and re-marking an already-read
    // row is idempotent (C-010). Always returns { read: true } — the unread badge derives from the
    // unread-count read, not from this response, so a no-op and a real flip look identical to the client.
    .post("/api/me/notifications/:id/read", async ({ params, actor }) => {
      await repo.markRead(actor.userId, params.id);
      return { read: true };
    })
    // POST /api/me/notifications/read-all — mark every unread row read for the caller (AS-015).
    // Nothing unread → 0 rows touched (C-010 idempotent). Returns the count of rows flipped.
    .post("/api/me/notifications/read-all", async ({ actor }) => {
      const marked = await repo.markAllRead(actor.userId);
      return { marked };
    })
    // GET /api/me/notifications/preferences — the caller's EFFECTIVE preferences for every
    // (type, channel) in the matrix: the matrix default unless an override row exists (AS-001/
    // AS-002), plus the master email switch state. C-005: scoped to actor.userId (session-derived),
    // never a body/path userId — Alice can never read Bob's prefs (AS-014).
    .get("/api/me/notifications/preferences", async ({ actor }) => {
      const prefsRepo = getPrefsRepo();
      const [overrides, masterEmailEnabled] = await Promise.all([
        prefsRepo.listOverrides(actor.userId),
        prefsRepo.getMasterEmailEnabled(actor.userId),
      ]);
      return {
        preferences: effectivePreferences(overrides),
        masterEmailEnabled,
      };
    })
    // PUT /api/me/notifications/preferences — set one-or-more (type, channel, enabled) overrides
    // and/or the master email switch, for the CALLER ONLY (C-005, AS-014). Each override is checked
    // against the matrix BEFORE any row is written: an unsupported pair (AS-003) or a locked-disable
    // (AS-015) is refused with a clear reason and stores NO row (the whole batch is rejected — no
    // partial write — so a single bad pair never leaves the others half-applied).
    .put("/api/me/notifications/preferences", async ({ body, actor }) => {
      const prefsRepo = getPrefsRepo();
      const input = validateBody(prefWriteSchema, body);

      // Validate the whole batch first (refusals store nothing — AS-003/AS-015).
      for (const o of input.overrides ?? []) {
        const reason = rejectWrite(o.type, o.channel, o.enabled);
        if (reason) {
          throw new ValidationError(
            reason === "locked_channel"
              ? "locked channel cannot be disabled"
              : reason === "unsupported_channel"
                ? "unsupported channel"
                : "unknown notification type",
            { details: [`${o.type}.${o.channel}: ${reason}`], field: `${o.type}.${o.channel}` },
          );
        }
      }

      // All pairs valid → persist (upsert on the unique key, so a concurrent same-pair write is
      // race-proof). Scoped to actor.userId only (C-005).
      for (const o of input.overrides ?? []) {
        await prefsRepo.setOverride(actor.userId, o.type, o.channel, o.enabled);
      }
      if (input.masterEmailEnabled !== undefined) {
        await prefsRepo.setMasterEmailEnabled(actor.userId, input.masterEmailEnabled);
      }

      const [overrides, masterEmailEnabled] = await Promise.all([
        prefsRepo.listOverrides(actor.userId),
        prefsRepo.getMasterEmailEnabled(actor.userId),
      ]);
      return {
        preferences: effectivePreferences(overrides),
        masterEmailEnabled,
      };
    });
}
