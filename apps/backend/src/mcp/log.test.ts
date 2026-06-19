// mcp-roundtrip S-001 — bearer redaction in /mcp logging (C-014/GAP-007).
// /mcp is envelope-exempt, so centralized redaction never runs; this is the
// chokepoint that must scrub the Authorization bearer before any log line.

import { describe, expect, test } from "bun:test";
import { redactAuthHeader, safeMcpLogFields } from "./log";

describe("redactAuthHeader (C-014)", () => {
  test("C-014: a Bearer token is replaced — no fragment of the secret survives", () => {
    const secret = "anch_pat_SUPERSECRETtokenvalue123";
    const out = redactAuthHeader(`Bearer ${secret}`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("SUPERSECRET");
    expect(out).toBe("Bearer [REDACTED]");
  });

  test("C-014: absent / non-Bearer values never echo the raw value", () => {
    expect(redactAuthHeader(null)).toBe("[absent]");
    expect(redactAuthHeader(undefined)).toBe("[absent]");
    expect(redactAuthHeader("")).toBe("[absent]");
    // A non-Bearer credential is also scrubbed (no value leak).
    expect(redactAuthHeader("Basic dXNlcjpwYXNz")).toBe("[REDACTED]");
    expect(redactAuthHeader("Basic dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
  });

  test("C-014: safeMcpLogFields builds a loggable snapshot that never contains the raw bearer", () => {
    const secret = "anch_pat_leakcanary";
    const fields = safeMcpLogFields("POST", "/mcp", `Bearer ${secret}`);
    expect(fields).toEqual({ method: "POST", path: "/mcp", authorization: "Bearer [REDACTED]" });
    expect(JSON.stringify(fields)).not.toContain(secret);
  });
});
