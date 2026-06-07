import { test, expect } from "bun:test";
import { renderMarkdown } from "./markdown";

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

test("AS-009: empty markdown renders to empty (no crash)", () => {
  expect(renderMarkdown("")).toBe("");
});
