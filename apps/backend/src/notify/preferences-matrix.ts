// Supported-channel matrix (notification-preferences S-001) — the SINGLE SOURCE OF TRUTH for
// which (notification type, channel) pairs exist, which are ON by default, and which are LOCKED.
//
// A preference row in `notification_preferences` is an OVERRIDE of a matrix default; absence means
// the matrix default applies. This module is pure (no DB, no IO) so both the write-API validation
// (refuse unsupported/locked pairs — AS-003/AS-015) and the effective-read (matrix default unless
// an override exists — AS-001/AS-002) compute against ONE definition.
//
// Matrix (spec Data Model):
//   | Event                     | in_app        | email           |
//   | new_feedback              | on            | on              |
//   | thread_activity           | on            | on              |
//   | suggestion_decided        | on            | on              |
//   | invited (doc shared)      | on            | on (upgraded)   |
//   | resolved                  | on            | — (unsupported) |
//   | detached                  | on (LOCKED)   | — (unsupported) |
//   | workspace_member_joined   | on            | off (opt-in)    |
//   | workspace_member_removed  | on (LOCKED)   | on              |
//   | workspace_invited         | on            | — (unsupported) |
//   | workspace_renamed         | on            | — (unsupported) |
//   | reply (legacy alias)      | on            | on              |
//
// `reply` is the legacy thread-activity alias (kept green in the enum until notify delivery folds
// it into thread_activity). It is INCLUDED here as on/on so a stray persisted `reply` row never
// hits an "unsupported type" path; the user-facing settings UI (S-003) renders thread_activity,
// not reply, so this is a defensive entry, not a visible row.

import type { NotificationType } from "./types";

export type NotificationChannel = "in_app" | "email";

/** One channel's policy for a type: whether it is supported, its default, and whether it is locked. */
export interface ChannelPolicy {
  /** The channel is offered for this type. An unsupported channel cannot be written (AS-003). */
  supported: boolean;
  /** The default value when no override row exists. Only meaningful when `supported`. */
  defaultEnabled: boolean;
  /** Locked-on: supported + on + cannot be disabled. A disable write is refused (AS-015 / C-002). */
  locked: boolean;
}

type TypeMatrix = Record<NotificationChannel, ChannelPolicy>;

// Helpers to keep the table below readable.
const on: ChannelPolicy = { supported: true, defaultEnabled: true, locked: false };
const off: ChannelPolicy = { supported: true, defaultEnabled: false, locked: false };
const lockedOn: ChannelPolicy = { supported: true, defaultEnabled: true, locked: true };
const none: ChannelPolicy = { supported: false, defaultEnabled: false, locked: false };

/**
 * The matrix, keyed by NotificationType. Every type in the `notification_type` enum has an entry
 * (a missing entry would be a build-time gap — see `assertMatrixCoversAllTypes` usage in tests).
 */
export const PREFERENCES_MATRIX: Record<NotificationType, TypeMatrix> = {
  new_feedback: { in_app: on, email: on },
  thread_activity: { in_app: on, email: on },
  suggestion_decided: { in_app: on, email: on },
  invited: { in_app: on, email: on }, // doc-share invited gains email by default (upgraded)
  resolved: { in_app: on, email: none },
  detached: { in_app: lockedOn, email: none }, // critical in-app, no toggle
  workspace_member_joined: { in_app: on, email: off }, // email supported but OFF by default (opt-in)
  workspace_member_removed: { in_app: lockedOn, email: on }, // in-app locked, email togglable
  workspace_invited: { in_app: on, email: none }, // email is the existing invite mail
  workspace_renamed: { in_app: on, email: none },
  reply: { in_app: on, email: on }, // legacy alias of thread_activity
};

export const ALL_CHANNELS: readonly NotificationChannel[] = ["in_app", "email"];

/** Look up a (type, channel) policy. Returns undefined for a type not in the matrix. */
export function policyFor(type: NotificationType, channel: NotificationChannel): ChannelPolicy | undefined {
  return PREFERENCES_MATRIX[type]?.[channel];
}

/** True iff the type offers this channel at all (AS-003 gate). */
export function isChannelSupported(type: NotificationType, channel: NotificationChannel): boolean {
  return policyFor(type, channel)?.supported === true;
}

/** True iff the (type, channel) is LOCKED (supported + on + cannot be disabled — AS-015 / C-002). */
export function isChannelLocked(type: NotificationType, channel: NotificationChannel): boolean {
  return policyFor(type, channel)?.locked === true;
}

/** The matrix default for a supported (type, channel); false for an unsupported pair. */
export function defaultEnabled(type: NotificationType, channel: NotificationChannel): boolean {
  const p = policyFor(type, channel);
  return p?.supported ? p.defaultEnabled : false;
}

/** Why a preference write was refused. */
export type WriteRejectReason = "unsupported_channel" | "locked_channel" | "unknown_type";

/**
 * Validate one (type, channel, enabled) override the API is about to store (C-005 writes are
 * caller-scoped; this is the pair-level policy check that runs before any row is touched):
 *  - an unsupported (type, channel) pair → "unsupported_channel" (AS-003), NO row stored;
 *  - disabling a LOCKED in-app channel (detached, workspace_member_removed) → "locked_channel"
 *    (AS-015 / C-002), NO row stored — the lock can't be bypassed via the API;
 *  - a type not in the matrix → "unknown_type".
 * Returns `null` when the write is allowed.
 */
export function rejectWrite(
  type: NotificationType,
  channel: NotificationChannel,
  enabled: boolean,
): WriteRejectReason | null {
  const p = policyFor(type, channel);
  if (!p) return "unknown_type";
  if (!p.supported) return "unsupported_channel";
  if (p.locked && enabled === false) return "locked_channel";
  return null;
}

/** One stored override row, as the effective-read consumes it. */
export interface PreferenceOverride {
  type: NotificationType;
  channel: NotificationChannel;
  enabled: boolean;
}

/** A single (type, channel) entry in the effective-preferences read. */
export interface EffectivePreference {
  type: NotificationType;
  channel: NotificationChannel;
  supported: boolean;
  locked: boolean;
  /** The effective value: the override if one exists and is honored, else the matrix default. */
  enabled: boolean;
}

/**
 * Compute the caller's EFFECTIVE preferences for every (type, channel) in the matrix from their
 * stored overrides (AS-001 fresh user → all matrix defaults; AS-002 an override flips one pair):
 *  - an unsupported pair always reads disabled + unsupported (no override can turn it on);
 *  - a LOCKED pair always reads enabled (a stray disable override is ignored on read — C-002
 *    defence-in-depth alongside the write refusal);
 *  - otherwise the override value when present, else the matrix default.
 * `masterEmailEnabled` is surfaced separately (see the read endpoint); it does NOT mutate the
 * per-pair values here (S-002 applies the master suppression at delivery, F6).
 */
export function effectivePreferences(overrides: PreferenceOverride[]): EffectivePreference[] {
  const overrideMap = new Map<string, boolean>();
  for (const o of overrides) {
    overrideMap.set(`${o.type}::${o.channel}`, o.enabled);
  }
  const out: EffectivePreference[] = [];
  for (const type of Object.keys(PREFERENCES_MATRIX) as NotificationType[]) {
    for (const channel of ALL_CHANNELS) {
      const p = PREFERENCES_MATRIX[type][channel];
      let enabled: boolean;
      if (!p.supported) {
        enabled = false;
      } else if (p.locked) {
        enabled = true; // never disable-able, ignore any stray override
      } else {
        const ov = overrideMap.get(`${type}::${channel}`);
        enabled = ov === undefined ? p.defaultEnabled : ov;
      }
      out.push({ type, channel, supported: p.supported, locked: p.locked, enabled });
    }
  }
  return out;
}
