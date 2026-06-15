// annotation-core-ui-types-modes S-004 / C-004 — the v0 FIXED shared label-preset DISPLAY set.
//
// The backend owns the canonical id set + server-side validation
// (`apps/backend/src/annotation/label-presets.ts`, DEFAULT_LABEL_PRESETS). The FE needs the DISPLAY
// metadata (id → { text, icon, color }) the picker rows + the rail label line render from. This is
// the SINGLE source for that metadata — both LabelPicker and ThreadCard's label line read it (no
// per-component map). Ids are kept in LOCKSTEP with the backend constant; a forged/unknown id is
// already refused server-side (AS-014), and an unknown id renders no label line (defence-in-depth).
//
// C-004: a v0 CONSTANT (~10), shared across all workspaces — NOT a per-workspace `label_presets`
// table (deferred to Phase 4). The order here is the display order in the picker.
//
// `icon` is an Icon-set glyph name (see `@/components/icon`); `color` is a CSS color used as the
// row's preset swatch + the rail label line tint (DESIGN.md: a label is a preset-coloured highlight;
// the deep-teal accent stays the chrome accent, these identity colours mark the label TYPE).

export interface LabelPreset {
  /** the canonical lowercase-kebab id (in lockstep with the backend DEFAULT_LABEL_PRESETS). */
  id: string;
  /** the display text shown in the picker row + the rail label line + the composer pre-fill body. */
  text: string;
  /** an Icon-set glyph name (`@/components/icon`). */
  icon: string;
  /** the preset's identity colour (CSS), used for the picker swatch + the rail label line tint. */
  color: string;
  /** OPTIONAL emoji glyph — the Like preset (`looks-good`) shows the canonical 👍 (UI Notes /
   *  prototype) instead of a line icon. When set it renders in place of `icon` in the rail line. */
  emoji?: string;
}

/**
 * The v0 label presets, in display order. `looks-good` is the built-in Like preset (S-003); the
 * rest are the review labels the spec enumerates (AS-013). Ids MUST match the backend
 * DEFAULT_LABEL_PRESETS exactly — the server validates a submitted label against that set (AS-014).
 */
export const LABEL_PRESETS: readonly LabelPreset[] = [
  { id: "looks-good", text: "Looks good", icon: "check", color: "#3f7a52", emoji: "👍" },
  { id: "clarify-this", text: "Clarify this", icon: "search", color: "#3a6ea5" },
  { id: "missing-overview", text: "Missing overview", icon: "docs", color: "#7a5a9e" },
  { id: "verify-this", text: "Verify this", icon: "shield", color: "#0b6b73" },
  { id: "give-example", text: "Give me an example", icon: "list", color: "#a85d3e" },
  { id: "match-patterns", text: "Match existing patterns", icon: "grid", color: "#3a6ea5" },
  { id: "consider-alternatives", text: "Consider alternatives", icon: "refresh", color: "#7a5a9e" },
  { id: "ensure-no-regression", text: "Ensure no regression", icon: "activity", color: "#a85d3e" },
  { id: "out-of-scope", text: "Out of scope", icon: "x", color: "#9a6700" },
  { id: "needs-tests", text: "Needs tests", icon: "alert", color: "#9a6700" },
  { id: "nice-approach", text: "Nice approach", icon: "check", color: "#3f7a52" },
] as const;

// Id → preset lookup, built once (the set is constant). Both the picker and the rail label line read
// from this so the display metadata has ONE home.
const PRESET_BY_ID: ReadonlyMap<string, LabelPreset> = new Map(
  LABEL_PRESETS.map((p) => [p.id, p]),
);

/**
 * The display metadata for a label id, or `undefined` for an unknown/foreign id. ThreadCard renders
 * NO label line for `undefined` (the server already validates ∈ preset set, AS-014 — this is
 * defence-in-depth so a stale/forged id never leaks a raw string into the rail).
 */
export function labelDisplay(id: string | undefined): LabelPreset | undefined {
  return id ? PRESET_BY_ID.get(id) : undefined;
}
