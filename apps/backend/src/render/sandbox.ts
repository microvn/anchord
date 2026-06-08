// HTML sandbox render path (story S-002). Untrusted, AI-generated HTML is served
// from a content route and rendered inside an iframe that runs scripts but has an
// OPAQUE origin (no allow-same-origin) — so its JS runs for real (AS-006) yet cannot
// read the app's cookies/DOM (AS-007). It is NOT sanitized (C-002): isolation, not
// stripping, is the defense. The CSP `sandbox` response header re-applies that
// isolation even on direct top-level navigation (defense in depth).

/** CSP that sandboxes the response: scripts allowed, origin stays opaque (no same-origin). */
export const CONTENT_SECURITY_POLICY = "sandbox allow-scripts";

/** Headers for the content route serving a published version. */
export function contentHeaders(): Record<string, string> {
  return {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Content-Type": "text/html; charset=utf-8",
  };
}

/** Iframe markup for the viewer: scripts run, origin opaque (no allow-same-origin). */
export function sandboxIframe(contentUrl: string): string {
  return `<iframe class="doc-frame" src="${contentUrl}" sandbox="allow-scripts" title="document"></iframe>`;
}

export interface ServedContent {
  body: string;
  headers: Record<string, string>;
}

/**
 * Serve a published version's content as-is (identity serializer — no sanitize, no
 * structural rewrite), with the sandbox headers. Malformed HTML is left untouched so
 * the browser renders it best-effort (AS-008).
 */
export function serveContent(content: string, _kind: "html" | "markdown" | "image"): ServedContent {
  return { body: content, headers: contentHeaders() };
}
