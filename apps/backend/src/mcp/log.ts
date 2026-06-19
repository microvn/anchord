// mcp-roundtrip S-001 / C-014 (GAP-007) — bearer redaction for /mcp logging.
//
// /mcp is envelope-EXEMPT (C-005), so the centralized redaction in http/envelope.ts never
// runs on this path. Any access/error log on /mcp MUST therefore redact the Authorization
// bearer itself, or a token leaks into logs in clear. `redactAuthHeader` is the single
// chokepoint every /mcp log line passes its header value through.

const REDACTED = "Bearer [REDACTED]";

/**
 * Redact the secret in an Authorization header value before it is logged. A `Bearer <token>`
 * becomes `Bearer [REDACTED]`; anything else (or absent) becomes the literal `[REDACTED]` so
 * no token fragment is ever emitted. Never returns the original token.
 */
export function redactAuthHeader(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "[absent]";
  if (/^Bearer[ \t]+/i.test(value)) return REDACTED;
  return "[REDACTED]";
}

/**
 * Build a safe, loggable snapshot of an /mcp request: method + path, with the Authorization
 * header redacted (C-014). The returned object NEVER contains the raw bearer.
 */
export function safeMcpLogFields(method: string, path: string, authHeader: string | null): {
  method: string;
  path: string;
  authorization: string;
} {
  return { method, path, authorization: redactAuthHeader(authHeader) };
}
