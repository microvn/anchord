import { test, expect } from "bun:test";
import { injectBlockIds } from "./block-id";
import { renderMarkdown } from "../render/markdown";

// annotation-core S-001 — block-id injection (C-001, supports AS-001/AS-002/AS-003).
// Pure string transform; no DB, no DOM library.

test("AS-001: HTML doc — block elements get positional block-{tag}-{n} ids (per-tag counter)", () => {
  const html =
    "<h1>Title</h1><p>First para</p><p>Second para</p><p>Payment expires after 24h</p>";
  const out = injectBlockIds(html);

  expect(out).toContain('<h1 id="block-h1-1">');
  expect(out).toContain('<p id="block-p-1">First para');
  expect(out).toContain('<p id="block-p-2">Second para');
  // Per-tag counter: the h1 does not consume a <p> number.
  expect(out).toContain('<p id="block-p-3">Payment expires after 24h');
  // Text content is preserved verbatim.
  expect(out).toContain("Payment expires after 24h");
});

test("AS-002: Markdown-rendered HTML — list items get block-li-{n} ids", () => {
  const html = renderMarkdown("- alpha\n- bravo\n- charlie");
  const out = injectBlockIds(html);

  expect(out).toContain('block-li-1');
  expect(out).toContain('block-li-2');
  expect(out).toContain('block-li-3');
  // The <ul> container is also a block.
  expect(out).toContain('block-ul-1');
});

test("AS-003 / C-001: a duplicate snippet in two blocks gets DISTINCT block ids", () => {
  // "see below" lives in the 3rd and 9th paragraph; each block is independently
  // addressable so the chosen one can be anchored (the anchoring itself is in annotation.test.ts).
  const blocks = Array.from({ length: 9 }, (_, i) =>
    i === 2 || i === 8 ? "<p>see below</p>" : `<p>para ${i + 1}</p>`,
  ).join("");
  const out = injectBlockIds(blocks);

  expect(out).toContain('<p id="block-p-3">see below</p>');
  expect(out).toContain('<p id="block-p-9">see below</p>');
  // The two duplicate snippets carry different ids.
  expect(out.match(/id="block-p-3"/g)?.length).toBe(1);
  expect(out.match(/id="block-p-9"/g)?.length).toBe(1);
});

test("C-001: an element that already has an id is NOT clobbered — gets data-block-id instead", () => {
  const html = '<p id="author-anchor">kept</p><p>fresh</p>';
  const out = injectBlockIds(html);

  // Author's id survives untouched...
  expect(out).toContain('id="author-anchor"');
  // ...and we add a data-block-id rather than a second id.
  expect(out).toContain('data-block-id="block-p-1"');
  // The id="…" of the first <p> is still only the author's one (no clobber).
  expect(out).not.toContain('<p id="block-p-1"');
  // The second <p> with no id gets a real id.
  expect(out).toContain('<p id="block-p-2">fresh</p>');
});

test("C-001: inline and self-closing tags are NOT stamped (only block elements)", () => {
  const html = '<p>text with <strong>bold</strong> and <br/> and <a href="#">link</a></p>';
  const out = injectBlockIds(html);

  expect(out).toContain('<p id="block-p-1">');
  // Inline tags untouched — no id leaks onto span/a/strong/br.
  expect(out).not.toContain('block-strong');
  expect(out).not.toContain('block-a-');
  expect(out).not.toContain('block-br');
  expect(out).toContain("<strong>bold</strong>");
});

test("C-001: empty HTML / no block elements — returned unchanged (boundary)", () => {
  expect(injectBlockIds("")).toBe("");
  expect(injectBlockIds("just text, no tags")).toBe("just text, no tags");
});

test("C-001: special characters / unicode in block text are preserved", () => {
  const html = "<p>Giá: 24h — “quote” &amp; <emoji>🚀</emoji></p>";
  const out = injectBlockIds(html);
  expect(out).toContain('<p id="block-p-1">');
  expect(out).toContain("Giá: 24h — “quote” &amp;");
  expect(out).toContain("🚀");
});

// render-publish S-006 (C-009) — the SAME injectBlockIds transform is what the serve
// path applies (see app.test.ts for the wiring proof). These re-assert its behavior
// against render-publish's own AS ids so the Spec Coverage Gate counts them, and add
// the malformed/empty (AS-022) depth the annotation-core suite above didn't cover.

test("AS-019: a doc with several block elements gets per-tag sequential block-{tag}-{n} ids", () => {
  // 3 paragraphs + 2 headings (AS-019 data).
  const html = "<h1>T</h1><h2>S</h2><p>one</p><p>two</p><p>three</p>";
  const out = injectBlockIds(html);
  expect(out).toContain('<h1 id="block-h1-1">');
  expect(out).toContain('<h2 id="block-h2-1">');
  expect(out).toContain('<p id="block-p-1">one');
  expect(out).toContain('<p id="block-p-2">two');
  expect(out).toContain('<p id="block-p-3">three'); // counter is per-tag, headings don't consume it
});

test("AS-020: an element with an existing id keeps it and gets data-block-id instead", () => {
  const out = injectBlockIds('<h2 id="intro">Intro</h2>'); // AS-020 data
  expect(out).toContain('id="intro"');
  expect(out).toContain('data-block-id="block-h2-1"');
  expect(out).not.toContain('<h2 id="block-h2-1"');
});

test("AS-021: the same text in two blocks resolves to distinct block ids", () => {
  const blocks = Array.from({ length: 9 }, (_, i) =>
    i === 2 || i === 8 ? "<p>see below</p>" : `<p>para ${i + 1}</p>`,
  ).join("");
  const out = injectBlockIds(blocks);
  expect(out).toContain('<p id="block-p-3">see below</p>');
  expect(out).toContain('<p id="block-p-9">see below</p>');
});

test("AS-022: malformed / unclosed tags are injected best-effort without throwing", () => {
  // unclosed <div>/<h1> (AS-022 / mirrors AS-008 best-effort) → no throw, markers applied.
  let out = "";
  expect(() => {
    out = injectBlockIds("<div><p>orphan paragraph<h1>still here");
  }).not.toThrow();
  expect(out).toContain("orphan paragraph");
  expect(out).toContain('id="block-p-1"');
});

test("AS-022: empty content returns empty without throwing", () => {
  expect(() => injectBlockIds("")).not.toThrow();
  expect(injectBlockIds("")).toBe("");
});
