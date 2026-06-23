import { test, expect } from "bun:test";
import {
  PREFERENCES_MATRIX,
  ALL_CHANNELS,
  effectivePreferences,
  rejectWrite,
  isChannelSupported,
  isChannelLocked,
  defaultEnabled,
  type EffectivePreference,
  type PreferenceOverride,
} from "./preferences-matrix";
import type { NotificationType } from "./types";

// The full notification taxonomy (mirrors the notification_type pgEnum). The matrix MUST cover
// every one (a missing entry would be a coverage gap, F11).
const ALL_TYPES: NotificationType[] = [
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

function find(prefs: EffectivePreference[], type: NotificationType, channel: "in_app" | "email") {
  return prefs.find((p) => p.type === type && p.channel === channel)!;
}

test("matrix covers every notification type and both channels", () => {
  for (const type of ALL_TYPES) {
    expect(PREFERENCES_MATRIX[type]).toBeDefined();
    for (const ch of ALL_CHANNELS) {
      expect(PREFERENCES_MATRIX[type][ch]).toBeDefined();
    }
  }
});

test("AS-001.T1: a fresh user (no overrides) reads in-app ON for every event", () => {
  const prefs = effectivePreferences([]);
  for (const type of ALL_TYPES) {
    // in_app is supported + on for EVERY type in the matrix.
    expect(find(prefs, type, "in_app")).toMatchObject({ supported: true, enabled: true });
  }
});

test("AS-001.T2: a fresh user reads email ON for the high-signal personal events", () => {
  const prefs = effectivePreferences([]);
  for (const type of [
    "new_feedback",
    "thread_activity",
    "suggestion_decided",
  ] as NotificationType[]) {
    expect(find(prefs, type, "email")).toMatchObject({ supported: true, enabled: true });
  }
});

test("AS-001.T3: a fresh user reads member_joined email OFF by default (the one default-off channel)", () => {
  const prefs = effectivePreferences([]);
  const wmj = find(prefs, "workspace_member_joined", "email");
  expect(wmj).toMatchObject({ supported: true, locked: false, enabled: false });
});

test("AS-001: events with no email channel read unsupported + disabled for a fresh user", () => {
  const prefs = effectivePreferences([]);
  for (const type of [
    "resolved",
    "detached",
    "invited",
    "workspace_invited",
    "workspace_renamed",
  ] as NotificationType[]) {
    expect(find(prefs, type, "email")).toMatchObject({ supported: false, enabled: false });
  }
});

test("AS-002: an override {new_feedback,email,off} persists in the effective read; every other pref stays on", () => {
  const overrides: PreferenceOverride[] = [
    { type: "new_feedback", channel: "email", enabled: false },
  ];
  const prefs = effectivePreferences(overrides);
  // The overridden pair reads off.
  expect(find(prefs, "new_feedback", "email").enabled).toBe(false);
  // Its sibling channel and every other default-on supported pair are unaffected.
  expect(find(prefs, "new_feedback", "in_app").enabled).toBe(true);
  expect(find(prefs, "thread_activity", "email").enabled).toBe(true);
  expect(find(prefs, "suggestion_decided", "email").enabled).toBe(true);
  // invited has no email channel (in-app only) — its email pair reads unsupported.
  expect(find(prefs, "invited", "email")).toMatchObject({ supported: false, enabled: false });
});

test("AS-003: an unsupported channel is refused by rejectWrite and reads unsupported", () => {
  // detached supports in_app only — email is not offered.
  expect(isChannelSupported("detached", "email")).toBe(false);
  expect(rejectWrite("detached", "email", true)).toBe("unsupported_channel");
  // even attempting OFF on an unsupported channel is refused (no row should ever exist).
  expect(rejectWrite("detached", "email", false)).toBe("unsupported_channel");
});

test("AS-015: disabling a LOCKED in-app channel is refused (detached + workspace_member_removed)", () => {
  expect(isChannelLocked("detached", "in_app")).toBe(true);
  expect(isChannelLocked("workspace_member_removed", "in_app")).toBe(true);
  expect(rejectWrite("detached", "in_app", false)).toBe("locked_channel");
  expect(rejectWrite("workspace_member_removed", "in_app", false)).toBe("locked_channel");
  // Re-enabling a locked channel (already on) is allowed (no-op write, not a refusal).
  expect(rejectWrite("detached", "in_app", true)).toBeNull();
});

test("AS-015: a stray disable override on a locked pair is IGNORED on the effective read (defence-in-depth, C-002)", () => {
  // Even if a {detached,in_app,false} row somehow existed, the read forces it on.
  const prefs = effectivePreferences([{ type: "detached", channel: "in_app", enabled: false }]);
  expect(find(prefs, "detached", "in_app").enabled).toBe(true);
  expect(find(prefs, "detached", "in_app").locked).toBe(true);
});

test("a supported, unlocked, default-on channel CAN be turned off (the normal opt-out path)", () => {
  expect(rejectWrite("new_feedback", "email", false)).toBeNull();
  expect(rejectWrite("workspace_member_removed", "email", false)).toBeNull();
});

test("an unknown type is refused", () => {
  // @ts-expect-error — exercising the runtime guard with a type outside the matrix
  expect(rejectWrite("totally_made_up", "in_app", true)).toBe("unknown_type");
});

test("defaultEnabled reflects the matrix (opt-in member_joined email = false)", () => {
  expect(defaultEnabled("workspace_member_joined", "email")).toBe(false);
  expect(defaultEnabled("workspace_member_joined", "in_app")).toBe(true);
  expect(defaultEnabled("resolved", "email")).toBe(false); // unsupported → false
});
