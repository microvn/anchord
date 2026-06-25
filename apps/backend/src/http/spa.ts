import { resolve, join, sep } from "node:path";
import { getOrCreateRequestId, type ErrorEnvelope } from "./envelope";

// self-host S-005 / C-007: the served app must never shadow the real backend surfaces. An
// unmatched request under one of these prefixes is a genuine 404 (API/content/health), NOT the
// SPA shell — otherwise an API client would get HTML for a mistyped endpoint.
const RESERVED_PREFIXES = ["/api", "/v/", "/health", "/mcp"];

// capability-share-link: the API under /s/ is ONLY the token sub-paths (/s/:token/redeem,
// /s/:token/resolve). The bare /s/:token is the SPA redeem PAGE (CapabilityRedeemScreen) and MUST
// fall through to index.html. A blanket "/s/" prefix wrongly 404'd that page — so reserve /s/
// only when the path carries a sub-segment beyond the token.
const CAPABILITY_API_SUBPATH = /^\/s\/[^/]+\/.+/;

/** True when `path` belongs to a backend surface that must keep its own response (C-007). */
export function isReservedApiPath(path: string): boolean {
  if (CAPABILITY_API_SUBPATH.test(path)) return true;
  return RESERVED_PREFIXES.some((p) => path === p || path === p.replace(/\/$/, "") || path.startsWith(p));
}

// Explicit content types — Elysia's response mapping does not preserve the type Bun.file infers,
// so we set it ourselves (AS-013). Unknown extensions fall back to octet-stream.
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function mimeFor(path: string): string {
  const i = path.lastIndexOf(".");
  const ext = i >= 0 ? path.slice(i).toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * Serve the built web app for an otherwise-unmatched GET (self-host S-005 / C-007):
 * an existing static file under `webRoot` is served as-is (assets — AS-013); anything else
 * falls back to `index.html` so the client-side router can take over (AS-010/AS-011).
 * Path traversal outside `webRoot` is refused (it just falls back to the shell).
 */
export async function serveSpa(webRoot: string, urlPath: string): Promise<Response> {
  const base = resolve(webRoot);
  const rel = urlPath.replace(/^\/+/, "");
  const candidate = rel ? resolve(base, rel) : base;
  const withinRoot = candidate === base || candidate.startsWith(base + sep);

  if (withinRoot && rel) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      // Bun.file().exists() is false for a directory, so this only matches real files.
      return new Response(file, { headers: { "content-type": mimeFor(candidate) } });
    }
  }

  const shellPath = join(base, "index.html");
  const shell = Bun.file(shellPath);
  if (!(await shell.exists())) {
    return new Response("web app not built", { status: 404 });
  }
  return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * The enveloped 404 for a reserved backend path that matched no concrete route (C-007). Built
 * here so an unmatched `/api/...` GET that falls into the SPA wildcard keeps the SAME API
 * envelope shape the rest of the backend uses — never the HTML shell.
 */
export function reservedNotFound(request: Request, path: string): Response {
  const requestId = getOrCreateRequestId(request.headers);
  const body: ErrorEnvelope = {
    success: false,
    error: { code: "NOT_FOUND", message: "Not found" },
    timestamp: new Date().toISOString(),
    path,
    statusCode: 404,
    requestId,
  };
  return new Response(JSON.stringify(body), {
    status: 404,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}
