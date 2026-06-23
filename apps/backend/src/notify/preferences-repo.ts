// Drizzle-backed read/write glue for notification preferences (notification-preferences S-001).
// THIN glue — no policy logic (the matrix in preferences-matrix.ts owns supported/locked/default,
// the route owns the refusal decision). Every query is scoped to a single userId (C-005
// READ/WRITE-OWN-ONLY): the route derives userId from the session actor and passes it here, so a
// caller can only ever touch their own rows. Integration-verified against a real Postgres later;
// the route + matrix logic are unit-tested with a fake repo.

import { and, eq } from "drizzle-orm";
import { notificationPreferences, notificationSettings } from "../db/schema";
import type { DB } from "../db/client";
import type { NotificationChannel, PreferenceOverride } from "./preferences-matrix";
import type { NotificationType } from "./types";

export interface PreferencesRepo {
  /** Every stored OVERRIDE row for the user (absence of a pair = matrix default). */
  listOverrides(userId: string): Promise<PreferenceOverride[]>;
  /** The user's master email switch (true when no settings row exists — default on). */
  getMasterEmailEnabled(userId: string): Promise<boolean>;
  /**
   * UPSERT one override on the (user, type, channel) unique key — a concurrent double-write of the
   * same pair collapses to one row (the race-proof path). Caller MUST have validated the pair
   * against the matrix first (the repo stores whatever it is given — policy lives in the route).
   */
  setOverride(
    userId: string,
    type: NotificationType,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<void>;
  /** Set the master email switch (upsert the one-row-per-user settings row). */
  setMasterEmailEnabled(userId: string, enabled: boolean): Promise<void>;
}

export function createPreferencesRepo(db: DB): PreferencesRepo {
  return {
    async listOverrides(userId) {
      const rows = await db
        .select({
          type: notificationPreferences.type,
          channel: notificationPreferences.channel,
          enabled: notificationPreferences.enabled,
        })
        .from(notificationPreferences)
        .where(eq(notificationPreferences.userId, userId));
      return rows.map((r) => ({
        type: r.type as NotificationType,
        channel: r.channel as NotificationChannel,
        enabled: r.enabled,
      }));
    },

    async getMasterEmailEnabled(userId) {
      const [row] = await db
        .select({ emailEnabled: notificationSettings.emailEnabled })
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, userId));
      // No row → default on (absence-means-default, mirrors the override rows).
      return row?.emailEnabled ?? true;
    },

    async setOverride(userId, type, channel, enabled) {
      await db
        .insert(notificationPreferences)
        .values({ userId, type, channel, enabled })
        .onConflictDoUpdate({
          target: [
            notificationPreferences.userId,
            notificationPreferences.type,
            notificationPreferences.channel,
          ],
          set: { enabled },
        });
    },

    async setMasterEmailEnabled(userId, enabled) {
      await db
        .insert(notificationSettings)
        .values({ userId, emailEnabled: enabled })
        .onConflictDoUpdate({
          target: notificationSettings.userId,
          set: { emailEnabled: enabled },
        });
    },
  };
}

// Re-export so the route can scope by the same userId type without importing schema directly.
export type { NotificationChannel } from "./preferences-matrix";
