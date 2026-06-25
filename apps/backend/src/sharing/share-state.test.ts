import { describe, it, expect } from "bun:test";
import {
  readShareState,
  capabilityShareUrl,
  type ShareStateRepo,
  type ShareStateRow,
} from "./share-state";
import type { AxisRole } from "./share";

// capability-share-link S-005 — the share-state read carries the EXTERNAL capability link
// (`/s/<token>`) so the owner's Share box can surface it (AS-012), and omits it (null) when the doc
// is not link-shared (AS-013). The aggregator is PURE over an injectable repo, so this exercises the
// shaping without a DB. The token's presence (not the level) decides: the repo reads a token only
// while the LINK AXIS is on (doc-access-two-axis S-001).

const TOKEN = "Hk3vQ2pLm8rT5wXyZ0aBcD"; // 22-char base64url, URL-safe

function fakeRepo(row: Partial<ShareStateRow>): ShareStateRepo {
  return {
    async readShareState(): Promise<ShareStateRow> {
      return {
        workspaceRole: null,
        linkRole: null,
        editorsCanShare: true,
        people: [],
        link: { hasPassword: false, expiresAt: null, viewLimit: null, viewCount: 0 },
        capabilityToken: null,
        ...row,
      };
    },
  };
}

// Drive the aggregator off the two axes (doc-access-two-axis S-001). The capability token's
// presence still decides whether the external link surfaces.
function read(linkRole: AxisRole, capabilityToken: string | null, workspaceRole: AxisRole = null) {
  return readShareState(
    "doc-1",
    "refund-spec-abc123",
    fakeRepo({ workspaceRole, linkRole, capabilityToken }),
    "owner",
  );
}

describe("capability-share-link S-005 — share state carries the capability link", () => {
  it("AS-012: an anyone-with-link doc carries the capability link /s/<token>, distinct from /d/<slug>", async () => {
    const state = await read("viewer", TOKEN);
    // The external link is the token form, NOT the readable in-app address.
    expect(state.capabilityUrl).toBe(`/s/${TOKEN}`);
    // It is visibly distinct from the in-app readable /d/<slug> address.
    expect(state.link.url).toBe("/d/refund-spec-abc123");
    expect(state.capabilityUrl).not.toBe(state.link.url);
    // The token form leaks no part of the doc title/slug.
    expect(state.capabilityUrl).not.toContain("refund");
  });

  it("AS-013: a restricted doc carries NO capability link (null)", async () => {
    const state = await read(null, null);
    expect(state.capabilityUrl).toBeNull();
    // The in-app readable address is still present (members reach the doc by it).
    expect(state.link.url).toBe("/d/refund-spec-abc123");
  });

  it("AS-013: an anyone-in-workspace doc (workspace axis on, link off) carries NO capability link (null)", async () => {
    const state = await read(null, null, "commenter");
    expect(state.capabilityUrl).toBeNull();
  });

  it("capabilityShareUrl: token → /s/<token>; null/empty → null", () => {
    expect(capabilityShareUrl(TOKEN)).toBe(`/s/${TOKEN}`);
    expect(capabilityShareUrl(null)).toBeNull();
    expect(capabilityShareUrl("")).toBeNull(); // empty token is treated as "no link"
  });
});

// doc-access-two-axis S-006 / C-008 — the share-state read carries BOTH the derived legacy
// `level` summary (deriveLevel, never stored) AND the raw {workspaceRole, linkRole} axes, so the
// Share dialog can show each axis precisely while the lossy 3-value summary keeps simpler
// displays working. The summary alone collapses workspace-shared vs link-only; the raw axes
// alongside it (AS-027) are what let a client tell them apart.
describe("doc-access-two-axis S-006 — reads expose raw axes + derived summary (C-008)", () => {
  it("AS-021: workspace on + link off → summary 'anyone_in_workspace' (derived, not stored)", async () => {
    const state = await read(null, null, "commenter"); // workspace=commenter, link=off
    expect(state.level).toBe("anyone_in_workspace");
    // The raw axes accompany the summary (C-008): workspace set, link off.
    expect(state.workspaceRole).toBe("commenter");
    expect(state.linkRole).toBeNull();
  });

  it("AS-022: workspace on + link on → summary 'anyone_with_link' (link axis dominates)", async () => {
    const state = await read("viewer", TOKEN, "commenter"); // workspace=commenter, link=viewer
    expect(state.level).toBe("anyone_with_link");
    // Raw axes still distinguish this from a link-only doc (C-008).
    expect(state.workspaceRole).toBe("commenter");
    expect(state.linkRole).toBe("viewer");
  });

  it("AS-027: two docs both summarize 'anyone_with_link' but raw axes tell workspace-shared from link-only", async () => {
    // Doc X: workspace=commenter, link=viewer (shared with the workspace AND link-shared).
    const x = await read("viewer", TOKEN, "commenter");
    // Doc Y: workspace=off, link=viewer (link-only).
    const y = await read("viewer", TOKEN, null);

    // The lossy summary collapses both to the same value...
    expect(x.level).toBe("anyone_with_link");
    expect(y.level).toBe("anyone_with_link");
    expect(x.level).toBe(y.level);

    // ...but the raw axes carried alongside it keep the distinction (C-008): X is also
    // workspace-shared, Y is link-only.
    expect(x.workspaceRole).toBe("commenter");
    expect(y.workspaceRole).toBeNull();
    expect(x.workspaceRole).not.toBe(y.workspaceRole);
    // Both share the same link axis — proving the difference lives in the workspace axis alone.
    expect(x.linkRole).toBe("viewer");
    expect(y.linkRole).toBe("viewer");
  });
});
