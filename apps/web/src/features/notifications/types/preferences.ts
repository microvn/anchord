// Wire types for the notification-preferences settings surface (notification-preferences S-003).
//
// These mirror the backend read/write shapes EXACTLY (apps/backend/src/notify/preferences-matrix.ts
// + src/routes/notifications.ts). The settings section is taxonomy-DRIVEN (AS-012): the row set is
// derived from the live `preferences` array the API returns, never a hardcoded FE list. Adding a
// (type, channel) to the backend matrix surfaces a new row here with no FE change.

/** The two delivery channels. Mirrors the backend `NotificationChannel`. */
export type PrefChannel = "in_app" | "email";

/**
 * One (type, channel) entry exactly as `GET /api/me/notifications/preferences` returns it. The
 * backend emits BOTH channels for every type — an unsupported channel carries `supported: false`
 * (so the FE knows to render no toggle for it), a critical channel carries `locked: true`
 * (rendered locked-on, no interaction — C-002).
 */
export interface EffectivePreference {
  /** The notification type id (matches the backend `notification_type` enum). Open string so a new
   *  backend type renders without a FE type-union edit (AS-012 taxonomy-driven). */
  type: string;
  channel: PrefChannel;
  /** The channel is offered for this type. `false` → render no toggle. */
  supported: boolean;
  /** Locked-on: supported + always-on, cannot be turned off (detached, member_removed in-app). */
  locked: boolean;
  /** The effective value: the stored override if any, else the matrix default. */
  enabled: boolean;
}

/** The full read payload (`GET`/`PUT` both return this). */
export interface NotificationPreferences {
  preferences: EffectivePreference[];
  /** The master email switch — when off, all email is suppressed at delivery (S-002). */
  masterEmailEnabled: boolean;
}

/** One override the PUT endpoint accepts. */
export interface PreferenceOverrideInput {
  type: string;
  channel: PrefChannel;
  enabled: boolean;
}
