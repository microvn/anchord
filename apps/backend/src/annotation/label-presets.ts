// annotation-core S-009 / C-015 — the v0 FIXED shared label-preset set.
//
// A signal annotation (comment/like/label) may carry a `label`: a preset id from this
// constant set. The Like affordance is the `looks-good` preset; the others are the review
// labels the spec enumerates. This is intentionally a CONSTANT, not a table — a
// per-workspace customizable preset table is deferred (annotation-core-ui-types-modes
// Phase 4). The create boundary validates a submitted label against this set server-side
// (C-015), refusing a foreign / forged id (AS-028).

/**
 * The v0 label presets. Order is the display order. `looks-good` is the Like preset
 * (S-009). Keep these as lowercase-kebab ids — the canonical form the server validates
 * and stores; labels are matched case-sensitively against this set.
 */
export const DEFAULT_LABEL_PRESETS = [
  "looks-good",
  "clarify-this",
  "missing-overview",
  "verify-this",
  "give-example",
  "match-patterns",
  "consider-alternatives",
  "ensure-no-regression",
  "out-of-scope",
  "needs-tests",
  "nice-approach",
] as const;

/** A known label-preset id. */
export type LabelPreset = (typeof DEFAULT_LABEL_PRESETS)[number];

// Membership lookup built once (the set is constant) so validation is O(1) per create.
const PRESET_SET: ReadonlySet<string> = new Set(DEFAULT_LABEL_PRESETS);

/**
 * Whether `label` is a member of the known preset set (C-015). A foreign / garbage /
 * markup-bearing id (AS-028) returns false → the create boundary refuses it. Matches the
 * exact lowercase-kebab id; an empty string is not a preset.
 */
export function isLabelPreset(label: string): label is LabelPreset {
  return PRESET_SET.has(label);
}
