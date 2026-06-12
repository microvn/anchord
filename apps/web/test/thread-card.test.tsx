import { describe, it, expect } from "bun:test";
import { avatarColor, AVATAR_COLORS } from "../src/features/viewer/thread-card";

// annotation-core-ui S-003 — the comment-item avatar color. 1:1 with Anchord-Design data.jsx
// `avatarColor`: a stable per-author color hashed from the name (h = h*31 + charCode, >>>0) into
// the fixed palette. The rest of the ThreadCard is pure styling ([→MANUAL] / Playwright); this is
// the one piece of logic, so it gets a unit test.

describe("avatarColor (S-003, matches Anchord-Design)", () => {
  it("hashes a name into the prototype palette — exact value for a known name", () => {
    // Hand-computed via the prototype algorithm: "Mara" → index 1 → #3a6ea5.
    expect(avatarColor("Mara")).toBe("#3a6ea5");
  });

  it("is deterministic and always returns a palette member", () => {
    expect(avatarColor("Demo User")).toBe(avatarColor("Demo User"));
    expect(AVATAR_COLORS).toContain(avatarColor("Demo User"));
    expect(AVATAR_COLORS).toContain(avatarColor("Whoever"));
  });

  it("falls back safely on an empty name", () => {
    expect(AVATAR_COLORS).toContain(avatarColor(""));
  });
});
