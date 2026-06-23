import { describe, it, expect } from "bun:test";
import { openDocHref } from "@/features/activity/lib/open-doc-href";

// The "Open doc" deep-link builder (workspace-activity S-004). Pure unit — the three "Open doc"
// behaviours hinge on this one function, so they are asserted here without a browser.

describe("openDocHref (workspace-activity S-004)", () => {
  it("AS-016: a comment event whose annotation still resolves → /d/<slug>#annotation-<id>", () => {
    const href = openDocHref({ docSlug: "render-pipeline-rfc", annotationId: "anno-sanitization" });
    // The viewer scrolls to that annotation on mount via the #annotation-<id> fragment.
    expect(href).toBe("/d/render-pipeline-rfc#annotation-anno-sanitization");
  });

  it("AS-017: a detached annotation (annotationId null) → /d/<slug> with NO fragment (opens at top)", () => {
    const href = openDocHref({ docSlug: "render-pipeline-rfc", annotationId: null });
    // No stale fragment — the doc opens at the top rather than failing on a detached anchor.
    expect(href).toBe("/d/render-pipeline-rfc");
  });

  it("AS-018: a deleted doc (no current slug) → null href so the caller degrades 'Open doc'", () => {
    expect(openDocHref({ docSlug: null, annotationId: "a1" })).toBeNull();
    expect(openDocHref({ docSlug: undefined, annotationId: null })).toBeNull();
  });
});
