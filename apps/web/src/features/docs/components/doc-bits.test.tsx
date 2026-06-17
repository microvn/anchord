import { describe, it, expect } from "bun:test";
import { render } from "@testing-library/react";

import { AnnotationCount } from "./doc-bits";

// workspace-project-ui S-007 (AS-019 / C-006): the per-doc browse cell shows the doc's
// ACTIVE-ANNOTATION count with an ANNOTATION icon — never an envelope/comment/mail glyph.
// The Icon component renders its glyph via dangerouslySetInnerHTML, so we assert against the
// SVG path data: the dedicated annotation glyph (`highlight`) must be present, and neither the
// envelope/comment glyph (inbox/mail) NOR the edit glyph (`pencil`, which means rename) is used —
// the annotation count owns its own icon.

const HIGHLIGHT_GLYPH = 'rect x="3.5" y="14.5" width="13" height="4"'; // the `highlight` annotation bar
const INBOX_GLYPH = "M3 12h5l1.5 3h5L21 12"; // doc-bits' old comment-count icon
const MAIL_GLYPH = "M3 5"; // the mail/envelope rect start (also forbidden)
const PENCIL_GLYPH = "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"; // the edit/rename glyph — NOT annotations

describe("workspace-project-ui S-007 — AnnotationCount", () => {
  it("AS-019.T3: renders the count beside the dedicated annotation icon, not edit/comment glyphs", () => {
    const { container } = render(<AnnotationCount count={3} />);
    expect(container.textContent).toContain("3");
    const html = container.innerHTML;
    // It uses the dedicated annotation (highlight) glyph...
    expect(html).toContain(HIGHLIGHT_GLYPH);
    // ...NOT the edit/rename pencil, and NOT the old envelope/comment iconography.
    expect(html).not.toContain(PENCIL_GLYPH);
    expect(html).not.toContain(INBOX_GLYPH);
    expect(html).not.toContain(MAIL_GLYPH);
  });

  it("AS-019.T3: a zero count still renders the number with the annotation icon", () => {
    const { container } = render(<AnnotationCount count={0} />);
    expect(container.textContent).toContain("0");
    expect(container.innerHTML).toContain(HIGHLIGHT_GLYPH);
  });
});
