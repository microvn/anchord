// In-process route tests for the render-publish POST /api/docs mount (no DB).
//
// These exercise the HTTP GLUE only — envelope + auth gate + Zod validation +
// PublishRejected→DomainError mapping — via app.handle(Request)→Response (no port,
// no Postgres). A fake DocRepo is injected so the route→service path runs without
// a DB; the real-Postgres path is covered by test/integration/docs-routes.itest.ts.
//
// AS map (render-publish S-001 / api-core):
//   AS-001  valid publish → 201 { docId, slug, url } in the success envelope.
//   AS-004  over-cap artifact → 413 PAYLOAD_TOO_LARGE.
//   AS-005  declared/sniffed type mismatch → 400 VALIDATION_ERROR.
//   AS-014  empty content → 400 VALIDATION_ERROR.
//   (gate)  no session → 401 UNAUTHENTICATED; bad body shape → 400.

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { DocRepo } from "../../src/publish/service";
import type { SessionResolver } from "../../src/http/auth-gate";
import { MAX_TEXT_BYTES } from "../../src/publish/sniff";

const member: SessionResolver = async () => ({ userId: "u_member" });
const noSession: SessionResolver = async () => null;

/** A DocRepo that records the last create and returns a fixed id (no DB). */
function fakeRepo(): DocRepo & { last?: unknown } {
  const r: DocRepo & { last?: unknown } = {
    async createDocWithV1(input) {
      r.last = input;
      return { id: "doc_fake_1" };
    },
  };
  return r;
}

function buildApp(opts: { resolveSession: SessionResolver; repo?: DocRepo }) {
  return createApp({
    dbCheck: async () => {},
    docs: { repo: opts.repo ?? fakeRepo(), resolveSession: opts.resolveSession },
  });
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/docs", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/docs route glue", () => {
  test("AS-001: valid markdown publish → 201 with { docId, slug, url } in envelope", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: member, repo });
    const res = await app.handle(post({ content: "# Hello world\n\nbody" }));

    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.statusCode).toBe(201);
    expect(json.data.docId).toBe("doc_fake_1");
    expect(typeof json.data.slug).toBe("string");
    expect(json.data.url).toBe(`/d/${json.data.slug}`);
    // service was actually called with the sniffed kind persisted
    expect((repo as any).last.kind).toBe("markdown");
  });

  test("AS-001: title override is honoured by the service", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: member, repo });
    const res = await app.handle(post({ content: "# Auto", title: "My Override" }));
    expect(res.status).toBe(201);
    expect((repo as any).last.title).toBe("My Override");
  });

  test("no session → 401 UNAUTHENTICATED (handler never runs)", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: noSession, repo });
    const res = await app.handle(post({ content: "# hi" }));
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("UNAUTHENTICATED");
    expect((repo as any).last).toBeUndefined();
  });

  test("bad body shape (missing content) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveSession: member });
    const res = await app.handle(post({ title: "no content" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.field).toBe("content");
  });

  test("AS-014: empty content → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveSession: member });
    const res = await app.handle(post({ content: "" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.message).toMatch(/empty/i);
  });

  test("AS-005: type mismatch (declared image, text bytes) → 400 VALIDATION_ERROR", async () => {
    const app = buildApp({ resolveSession: member });
    const res = await app.handle(post({ content: "just text", kind: "image" }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("AS-004: over-cap content → 413 PAYLOAD_TOO_LARGE", async () => {
    const app = buildApp({ resolveSession: member });
    const big = "a".repeat(MAX_TEXT_BYTES + 1); // 1 byte over the 5MB text cap
    const res = await app.handle(post({ content: big }));
    expect(res.status).toBe(413);
    const json = (await res.json()) as any;
    expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  test("unknown body fields are stripped (never reach the service)", async () => {
    const repo = fakeRepo();
    const app = buildApp({ resolveSession: member, repo });
    const res = await app.handle(post({ content: "# ok", isAdmin: true, extra: 1 } as any));
    expect(res.status).toBe(201);
    // service only ever saw schema fields; the create input has no forged keys
    expect((repo as any).last).not.toHaveProperty("isAdmin");
  });
});
