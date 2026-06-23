import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import type {
  EffectivePreference,
  NotificationPreferences,
  PrefChannel,
} from "@/features/notifications/types/preferences";

// notification-preferences S-003 — Settings → Notifications section (FE half).
//
// SEAM (AS-012): we feed the mock the REAL backend taxonomy shape — the full 11-type matrix from
// apps/backend/src/notify/preferences-matrix.ts, expanded to the (type, channel) effective rows the
// GET endpoint returns — and assert the rendered row set is DERIVED from that response, not a
// hardcoded FE list. The store is the single source of truth the mock thunks read/write, mirroring
// the backend's matrix + write rules (refuse unsupported / locked-disable). bun's mock.module is
// process-wide + persistent → reset the store in beforeEach and the mock fns in afterEach.

// The matrix exactly as preferences-matrix.ts encodes it (on/off/lockedOn/none), per channel.
type Policy = { supported: boolean; defaultEnabled: boolean; locked: boolean };
const on: Policy = { supported: true, defaultEnabled: true, locked: false };
const off: Policy = { supported: true, defaultEnabled: false, locked: false };
const lockedOn: Policy = { supported: true, defaultEnabled: true, locked: true };
const none: Policy = { supported: false, defaultEnabled: false, locked: false };

const MATRIX: Record<string, { in_app: Policy; email: Policy }> = {
  new_feedback: { in_app: on, email: on },
  thread_activity: { in_app: on, email: on },
  suggestion_decided: { in_app: on, email: on },
  invited: { in_app: on, email: none }, // doc-share invited is in-app only (the invite email is separate)
  resolved: { in_app: on, email: none },
  detached: { in_app: lockedOn, email: none },
  workspace_member_joined: { in_app: on, email: off },
  workspace_member_removed: { in_app: lockedOn, email: on },
  workspace_invited: { in_app: on, email: none },
  workspace_renamed: { in_app: on, email: none },
  reply: { in_app: on, email: on }, // legacy alias — backend returns it; FE must NOT render a row
};

const CHANNELS: PrefChannel[] = ["in_app", "email"];

// Overrides the "user" has stored (type::channel → enabled). Empty = all matrix defaults (AS-001).
let overrides: Map<string, boolean>;
let masterEmailEnabled: boolean;

// Compute the effective preferences EXACTLY like the backend's effectivePreferences(): unsupported →
// disabled+unsupported; locked → always enabled (stray override ignored); else override-or-default.
function effective(): EffectivePreference[] {
  const out: EffectivePreference[] = [];
  for (const type of Object.keys(MATRIX)) {
    for (const channel of CHANNELS) {
      const p = MATRIX[type][channel];
      let enabled: boolean;
      if (!p.supported) enabled = false;
      else if (p.locked) enabled = true;
      else {
        const ov = overrides.get(`${type}::${channel}`);
        enabled = ov === undefined ? p.defaultEnabled : ov;
      }
      out.push({ type, channel, supported: p.supported, locked: p.locked, enabled });
    }
  }
  return out;
}

function envelope(): { data: { success: true; data: NotificationPreferences }; error: null } {
  return { data: { success: true, data: { preferences: effective(), masterEmailEnabled } }, error: null };
}

const fetchNotificationPreferences = mock(async () => envelope());

// Mirror the backend write rules: refuse unsupported + locked-disable (no row stored), else persist.
let updateShouldFail = false;
const updateNotificationPreference = mock(
  async (override: { type: string; channel: PrefChannel; enabled: boolean }) => {
    if (updateShouldFail) {
      return { data: null, error: { status: 500, value: "boom" } };
    }
    const p = MATRIX[override.type]?.[override.channel];
    if (!p || !p.supported || (p.locked && override.enabled === false)) {
      return { data: null, error: { status: 400, value: "refused" } };
    }
    overrides.set(`${override.type}::${override.channel}`, override.enabled);
    return envelope();
  },
);

mock.module("@/features/notifications/services/client", () => ({
  fetchNotificationPreferences,
  updateNotificationPreference,
}));

const { NotificationsSettingsSection } = await import(
  "@/features/notifications/components/notifications-settings-section"
);

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NotificationsSettingsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  overrides = new Map();
  masterEmailEnabled = true;
  updateShouldFail = false;
});
afterEach(() => {
  fetchNotificationPreferences.mockClear();
  updateNotificationPreference.mockClear();
});

// The user-facing types (the 11 backend types minus the legacy `reply` alias).
const VISIBLE_TYPES = Object.keys(MATRIX).filter((t) => t !== "reply");

describe("notification-preferences S-003 — Notifications settings section", () => {
  it("AS-008: reflects saved preferences per event (new-feedback email off, others on)", async () => {
    overrides.set("new_feedback::email", false);
    renderSection();

    const row = await screen.findByTestId("pref-row-new_feedback");
    // new_feedback: in-app on, email OFF.
    expect(within(row).getByTestId("pref-toggle-new_feedback-in_app")).toHaveAttribute("data-on", "1");
    expect(within(row).getByTestId("pref-toggle-new_feedback-email")).toHaveAttribute("data-on", "0");
    // Every other event's channels stay on (spot-check thread_activity + suggestion_decided email).
    expect(screen.getByTestId("pref-toggle-thread_activity-email")).toHaveAttribute("data-on", "1");
    expect(screen.getByTestId("pref-toggle-suggestion_decided-email")).toHaveAttribute("data-on", "1");
  });

  it("AS-009: toggling email for thread-activity saves (optimistic) and survives a re-render", async () => {
    const user = userEvent.setup();
    renderSection();

    const toggle = await screen.findByTestId("pref-toggle-thread_activity-email");
    expect(toggle).toHaveAttribute("data-on", "1");
    await user.click(toggle);

    // Optimistic: the switch flips immediately.
    await waitFor(() =>
      expect(screen.getByTestId("pref-toggle-thread_activity-email")).toHaveAttribute("data-on", "0"),
    );
    // Persisted: the override is stored server-side (the write thunk was called with the pair).
    expect(updateNotificationPreference).toHaveBeenCalledWith({
      type: "thread_activity",
      channel: "email",
      enabled: false,
    });
    // Survives reload — a fresh mount reads the now-saved store and still shows email off.
    renderSection();
    await waitFor(() => {
      const toggles = screen.getAllByTestId("pref-toggle-thread_activity-email");
      expect(toggles[toggles.length - 1]).toHaveAttribute("data-on", "0");
    });
  });

  it("AS-009 (error path): a failed save reverts the optimistic flip", async () => {
    const user = userEvent.setup();
    updateShouldFail = true;
    renderSection();

    const toggle = await screen.findByTestId("pref-toggle-thread_activity-email");
    expect(toggle).toHaveAttribute("data-on", "1");
    await user.click(toggle);

    // It flips back to on after the write rejects (rollback).
    await waitFor(() =>
      expect(screen.getByTestId("pref-toggle-thread_activity-email")).toHaveAttribute("data-on", "1"),
    );
  });

  it("AS-010 / C-002: detached in-app is locked-on with no email toggle; member_removed in-app locked-on but email available", async () => {
    renderSection();

    // detached: in-app locked ON (disabled), and NO email toggle at all (unsupported).
    const detached = await screen.findByTestId("pref-row-detached");
    const detachedInApp = within(detached).getByTestId("pref-toggle-detached-in_app");
    expect(detachedInApp).toHaveAttribute("data-on", "1");
    expect(detachedInApp).toHaveAttribute("data-locked", "1");
    expect(detachedInApp).toBeDisabled();
    expect(within(detached).queryByTestId("pref-toggle-detached-email")).not.toBeInTheDocument();

    // workspace_member_removed: in-app locked ON, but email toggle IS present and interactive.
    const removed = screen.getByTestId("pref-row-workspace_member_removed");
    const removedInApp = within(removed).getByTestId("pref-toggle-workspace_member_removed-in_app");
    expect(removedInApp).toHaveAttribute("data-locked", "1");
    expect(removedInApp).toBeDisabled();
    const removedEmail = within(removed).getByTestId("pref-toggle-workspace_member_removed-email");
    expect(removedEmail).toBeInTheDocument();
    expect(removedEmail).not.toBeDisabled();
  });

  it("AS-011 / C-004: the daily-digest row is email-only, off, disabled, and toggling others never enables it", async () => {
    const user = userEvent.setup();
    renderSection();

    const digest = await screen.findByTestId("pref-row-digest");
    const digestToggle = within(digest).getByTestId("pref-toggle-digest-email");
    expect(digestToggle).toHaveAttribute("data-on", "0");
    expect(digestToggle).toBeDisabled();
    expect(within(digest).getByTestId("digest-coming-soon")).toBeInTheDocument();
    // Email-only: no in-app toggle on the digest row.
    expect(within(digest).queryByTestId("pref-toggle-digest-in_app")).not.toBeInTheDocument();

    // Toggling a different preference does NOT enable the digest.
    await user.click(screen.getByTestId("pref-toggle-new_feedback-email"));
    await waitFor(() =>
      expect(screen.getByTestId("pref-toggle-new_feedback-email")).toHaveAttribute("data-on", "0"),
    );
    expect(screen.getByTestId("pref-toggle-digest-email")).toHaveAttribute("data-on", "0");
    expect(screen.getByTestId("pref-toggle-digest-email")).toBeDisabled();
  });

  it("AS-012 (SEAM): rows are derived from the LIVE taxonomy — one row per firing type, correct channels, no extra/missing", async () => {
    renderSection();
    await screen.findByTestId("pref-row-new_feedback");

    // Exactly one row per VISIBLE type in the live taxonomy (reply excluded as a hidden alias).
    for (const type of VISIBLE_TYPES) {
      expect(screen.getByTestId(`pref-row-${type}`)).toBeInTheDocument();
    }
    // The legacy alias has NO row.
    expect(screen.queryByTestId("pref-row-reply")).not.toBeInTheDocument();
    // No row for a type that does not fire (not in the taxonomy).
    expect(screen.queryByTestId("pref-row-nonexistent_type")).not.toBeInTheDocument();

    // Row count (excluding the digest placeholder) equals the visible-type count — no extras.
    const allRows = screen.getAllByTestId(/^pref-row-/).filter((el) => el.dataset.testid !== "pref-row-digest");
    expect(allRows).toHaveLength(VISIBLE_TYPES.length);

    // Channels match the matrix: a supported-channel renders a toggle; an unsupported one does not.
    for (const type of VISIBLE_TYPES) {
      for (const channel of CHANNELS) {
        const toggle = screen.queryByTestId(`pref-toggle-${type}-${channel}`);
        if (MATRIX[type][channel].supported) {
          expect(toggle, `${type}.${channel} should render`).toBeInTheDocument();
        } else {
          expect(toggle, `${type}.${channel} should NOT render`).not.toBeInTheDocument();
        }
      }
    }
  });

  it("AS-012: an UNKNOWN live taxonomy type the FE grouping map missed still renders (default group)", async () => {
    // Inject a type the FE meta map has no entry for — it must still render a row, not be dropped.
    MATRIX.future_event = { in_app: on, email: on };
    try {
      renderSection();
      await waitFor(() => expect(screen.getByTestId("pref-row-future_event")).toBeInTheDocument());
      expect(screen.getByTestId("pref-toggle-future_event-in_app")).toBeInTheDocument();
      expect(screen.getByTestId("pref-toggle-future_event-email")).toBeInTheDocument();
    } finally {
      delete MATRIX.future_event;
    }
  });
});
