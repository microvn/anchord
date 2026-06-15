import { test, expect } from "bun:test";
import { DEFAULT_LABEL_PRESETS, isLabelPreset } from "./label-presets";

// annotation-core S-009 / C-015 — the v0 fixed shared label-preset CONSTANT set and the
// server-side membership check the create boundary validates against (AS-028). Pure data +
// a predicate; no DB. A per-workspace customizable table is deferred (types-modes Phase 4).

test("C-015: DEFAULT_LABEL_PRESETS is the v0 fixed set including the Like preset looks-good", () => {
  // The Like affordance is the `looks-good` preset (spec Data Model + S-009 description).
  expect(DEFAULT_LABEL_PRESETS).toContain("looks-good");
  // A representative spread of the labelling presets the spec enumerates.
  expect(DEFAULT_LABEL_PRESETS).toContain("out-of-scope");
  expect(DEFAULT_LABEL_PRESETS).toContain("needs-tests");
  // The set is non-trivial (~10) and free of duplicates.
  expect(DEFAULT_LABEL_PRESETS.length).toBeGreaterThanOrEqual(10);
  expect(new Set(DEFAULT_LABEL_PRESETS).size).toBe(DEFAULT_LABEL_PRESETS.length);
});

test("C-015: isLabelPreset accepts a known preset id", () => {
  expect(isLabelPreset("looks-good")).toBe(true);
  expect(isLabelPreset("out-of-scope")).toBe(true);
});

test("AS-028 / C-015: isLabelPreset rejects a foreign / garbage / markup-bearing id", () => {
  expect(isLabelPreset("<svg onload=alert(1)>")).toBe(false);
  expect(isLabelPreset("not-a-real-preset")).toBe(false);
  expect(isLabelPreset("")).toBe(false);
  // case-sensitive: the canonical id is the lowercase kebab form.
  expect(isLabelPreset("Looks-Good")).toBe(false);
});
