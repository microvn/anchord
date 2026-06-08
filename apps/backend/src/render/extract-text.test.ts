// Unit tests for extractText (workspace-project S-005, GAP-003 / C-006). Proves the
// publish-time text extraction that feeds the search index: HTML/MD → plain visible
// text, scripts/styles dropped, entities decoded, empty → empty.

import { describe, expect, test } from "bun:test";
import { extractText } from "./extract-text";

describe("extractText (S-005 / C-006)", () => {
  test("C-006: markdown → plain text (headings + body, tags stripped)", () => {
    const out = extractText("# Payment Spec\n\nThe **refund** policy applies.", "markdown");
    expect(out).toContain("Payment Spec");
    expect(out).toContain("refund");
    expect(out).not.toContain("<"); // no tags survive
    expect(out).not.toContain("#"); // markdown syntax rendered away
  });

  test("C-006: html → visible text only; <script> body never indexed", () => {
    const out = extractText(
      `<h1>Invoice</h1><p>total due</p><script>var leak = "secretToken123";</script>`,
      "html",
    );
    expect(out).toContain("Invoice");
    expect(out).toContain("total due");
    // The script SOURCE must not land in the index (sanitize drops it before stripping).
    expect(out).not.toContain("secretToken123");
    expect(out).not.toContain("var leak");
  });

  test("adjacent block tags don't fuse words", () => {
    const out = extractText("<p>alpha</p><p>beta</p>", "html");
    expect(out).toBe("alpha beta");
  });

  test("html entities are decoded back to characters", () => {
    const out = extractText("<p>Tom &amp; Jerry &lt;tag&gt;</p>", "html");
    expect(out).toContain("Tom & Jerry");
    expect(out).toContain("<tag>");
  });

  test("image kind → the alt/filename text, normalized", () => {
    expect(extractText("architecture-diagram.png", "image")).toBe("architecture-diagram.png");
  });

  test("empty / whitespace-only content → empty string", () => {
    expect(extractText("", "markdown")).toBe("");
    expect(extractText("   \n  ", "html")).toBe("");
  });
});
