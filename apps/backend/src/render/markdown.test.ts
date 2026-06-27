import { test, expect } from "bun:test";
import { renderMarkdown, renderForAnchoring } from "./markdown";

test("AS-009: renderMarkdown renders headings, lists and paragraphs to styled HTML", () => {
  const html = renderMarkdown("# Release Notes\n\n- one\n- two\n\nA paragraph.");
  expect(html).toContain("<h1");
  expect(html).toContain("Release Notes");
  expect(html).toContain("<ul");
  expect(html).toContain("<li");
  expect(html).toContain("<p>A paragraph.</p>");
});

test("AS-010 / C-002: renderMarkdown strips a raw <script> so it never executes", () => {
  const html = renderMarkdown("Hello\n\n<script>window.__pwned=1</script>\n\nworld");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("__pwned");
  // surrounding prose survives
  expect(html).toContain("Hello");
  expect(html).toContain("world");
});

test("AS-010 / C-002: renderMarkdown strips event-handler attributes (onerror/onclick)", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)"> <a href="#" onclick="x()">k</a>');
  expect(html).not.toContain("onerror");
  expect(html).not.toContain("onclick");
});

test("AS-010 / C-002: renderMarkdown never emits an executable javascript: link", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  // markdown-it refuses the unsafe scheme and renders inert text; the danger is an
  // anchor with a javascript: href — assert that never appears.
  expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
  expect(html).not.toContain("<a ");
});

// Regression: H-6 markdown remote-subresource exfiltration
// Markdown renders in the TRUSTED app origin (not the sandbox iframe), so a remote-loading
// attribute (`<img src=http…>`, `srcset`, `<video poster>`, `style:url(http…)`) beacons out to
// an attacker the moment anyone views the doc. DOMPurify's default html profile strips scripts
// but KEEPS these remote subresource loads — they must be neutralized too.
test("H-6: renderMarkdown strips remote <img src> (markdown image and raw <img>)", () => {
  const fromMd = renderMarkdown("![x](https://evil.example/x.png)");
  expect(fromMd).not.toContain("https://evil.example/x.png");
  const fromRaw = renderMarkdown('<img src="https://evil.example/x.png">');
  expect(fromRaw).not.toContain("https://evil.example/x.png");
});

test("H-6: renderMarkdown strips srcset and <video poster> remote loads", () => {
  const html = renderMarkdown(
    '<img src="https://evil.example/x.png" srcset="https://evil.example/2x.png 2x">\n\n' +
      '<video poster="https://evil.example/p.png"></video>',
  );
  expect(html).not.toContain("srcset");
  expect(html).not.toContain("poster");
  expect(html).not.toContain("evil.example");
});

test("H-6: renderMarkdown drops inline style with remote url() (CSS background beacon)", () => {
  const html = renderMarkdown('<p style="background:url(https://evil.example/b.png)">hi</p>');
  expect(html).not.toContain("evil.example");
  expect(html).not.toContain("background:url");
  // surrounding prose survives
  expect(html).toContain("hi");
});

test("H-6: renderMarkdown KEEPS legitimate data: and same-origin relative images", () => {
  const dataImg = renderMarkdown('<img src="data:image/png;base64,AAAA" alt="inline">');
  expect(dataImg).toContain("data:image/png;base64,AAAA");
  const relImg = renderMarkdown('<img src="/local/diagram.png" alt="local">');
  expect(relImg).toContain("/local/diagram.png");
});

test("AS-009: empty markdown renders to empty (no crash)", () => {
  expect(renderMarkdown("")).toBe("");
});

// renderForAnchoring: the ONE chokepoint that decides whether stored content must be rendered
// to HTML before the re-anchor matcher. block-ids only exist post-render, so markdown MUST be
// rendered; html/image pass through unchanged. Owns the decision so callers can't get it wrong.
test("renderForAnchoring(markdown) renders to HTML (block elements like <h1>/<td> exist post-render)", () => {
  const html = renderForAnchoring("# Title\n\n| a |\n|---|\n| cell |", "markdown");
  expect(html).toContain("<h1");
  expect(html).toContain("<td");
  expect(html).toContain("Title");
});

test("renderForAnchoring(html) passes content through UNCHANGED", () => {
  const input = "<h1>Already HTML</h1><p>body</p>";
  expect(renderForAnchoring(input, "html")).toBe(input);
});

test("renderForAnchoring(image) passes content through unchanged", () => {
  const input = "https://example.com/img.png";
  expect(renderForAnchoring(input, "image")).toBe(input);
});
