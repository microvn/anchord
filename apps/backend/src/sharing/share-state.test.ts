import { describe, it, expect } from "bun:test";
import {
  readShareState,
  capabilityShareUrl,
  type ShareStateRepo,
  type ShareStateRow,
} from "./share-state";
import type { GeneralAccessLevel } from "./share";

// capability-share-link S-005 — the share-state read carries the EXTERNAL capability link
// (`/s/<token>`) so the owner's Share box can surface it (AS-012), and omits it (null) when the doc
// is not link-shared (AS-013). The aggregator is PURE over an injectable repo, so this exercises the
// shaping without a DB. The token's presence (not the level) decides: the repo reads a token only
// while the doc is anyone_with_link (capability-share-link C-001/C-004).

const TOKEN = "Hk3vQ2pLm8rT5wXyZ0aBcD"; // 22-char base64url, URL-safe

function fakeRepo(row: Partial<ShareStateRow>): ShareStateRepo {
  return {
    async readShareState(): Promise<ShareStateRow> {
      return {
        level: "restricted",
        role: "viewer",
        editorsCanShare: true,
        people: [],
        link: { hasPassword: false, expiresAt: null, viewLimit: null, viewCount: 0 },
        capabilityToken: null,
        ...row,
      };
    },
  };
}

function read(level: GeneralAccessLevel, capabilityToken: string | null) {
  return readShareState("doc-1", "refund-spec-abc123", fakeRepo({ level, capabilityToken }), "owner");
}

describe("capability-share-link S-005 — share state carries the capability link", () => {
  it("AS-012: an anyone-with-link doc carries the capability link /s/<token>, distinct from /d/<slug>", async () => {
    const state = await read("anyone_with_link", TOKEN);
    // The external link is the token form, NOT the readable in-app address.
    expect(state.capabilityUrl).toBe(`/s/${TOKEN}`);
    // It is visibly distinct from the in-app readable /d/<slug> address.
    expect(state.link.url).toBe("/d/refund-spec-abc123");
    expect(state.capabilityUrl).not.toBe(state.link.url);
    // The token form leaks no part of the doc title/slug.
    expect(state.capabilityUrl).not.toContain("refund");
  });

  it("AS-013: a restricted doc carries NO capability link (null)", async () => {
    const state = await read("restricted", null);
    expect(state.capabilityUrl).toBeNull();
    // The in-app readable address is still present (members reach the doc by it).
    expect(state.link.url).toBe("/d/refund-spec-abc123");
  });

  it("AS-013: an anyone-in-workspace doc carries NO capability link (null)", async () => {
    const state = await read("anyone_in_workspace", null);
    expect(state.capabilityUrl).toBeNull();
  });

  it("capabilityShareUrl: token → /s/<token>; null/empty → null", () => {
    expect(capabilityShareUrl(TOKEN)).toBe(`/s/${TOKEN}`);
    expect(capabilityShareUrl(null)).toBeNull();
    expect(capabilityShareUrl("")).toBeNull(); // empty token is treated as "no link"
  });
});
