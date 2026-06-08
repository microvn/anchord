import { test, expect } from "bun:test";
import { CONTENT_SECURITY_POLICY, contentHeaders, sandboxIframe } from "./sandbox";

test("AS-007 / C-001: content is served with a CSP sandbox header that forces an opaque origin", () => {
  // `sandbox` (without allow-same-origin) gives the response an opaque origin even on
  // direct top-level navigation, so untrusted content can't reach the app's origin.
  expect(CONTENT_SECURITY_POLICY).toContain("sandbox");
  expect(CONTENT_SECURITY_POLICY).toContain("allow-scripts");
  expect(CONTENT_SECURITY_POLICY).not.toContain("allow-same-origin");
  const h = contentHeaders();
  expect(h["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY);
  expect(h["X-Content-Type-Options"]).toBe("nosniff");
});

test("AS-006 / C-001: the viewer iframe runs scripts but is NOT same-origin", () => {
  const frame = sandboxIframe("/v/abc/index.html");
  expect(frame).toContain('sandbox="allow-scripts"');
  expect(frame).not.toContain("allow-same-origin");
  expect(frame).toContain('src="/v/abc/index.html"');
});

test("AS-008: serving does not pre-sanitize/alter the HTML body (best-effort render of malformed input)", () => {
  // The sandbox path serves bytes as-is — no dompurify, no structural rewrite — so the
  // browser renders even malformed HTML best-effort. Assert the serializer is identity.
  const { serveContent } = require("./sandbox");
  const malformed = "<div><p>unterminated";
  const res = serveContent(malformed, "html");
  expect(res.body).toBe(malformed); // unchanged
  expect(res.headers["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY);
});
