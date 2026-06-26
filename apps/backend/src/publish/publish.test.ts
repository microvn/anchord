import { test, expect } from "bun:test";
import { publishDoc, type DocRepo, type CreateDocInput } from "./service";
import { deriveTitle } from "./title";
import { sniffKind, validateSize, PublishRejected, MAX_TEXT_BYTES, MAX_IMAGE_BYTES } from "./sniff";

const enc = (s: string) => new TextEncoder().encode(s);

// In-memory fake repo: records every create, hands back a stable id, and lets a test
// re-read what was stored (to assert the slug is set once and not regenerated).
// project-visibility S-004 (C-013): the repo now also returns the target project + the
// derived access axes; the fake echoes a configurable result so the transparency fields
// (PublishResult.project / .access) can be asserted at the unit layer.
function fakeRepo(opts?: {
  projectName?: string | null;
  workspaceRole?: "viewer" | "commenter" | "editor" | null;
  linkRole?: "viewer" | "commenter" | "editor" | null;
}) {
  const rows: (CreateDocInput & { id: string; version: 1 })[] = [];
  let n = 0;
  const repo: DocRepo = {
    async createDocWithV1(input) {
      const id = `doc-${++n}`;
      rows.push({ ...input, id, version: 1 });
      return {
        id,
        projectId: input.projectId ?? null,
        projectName: opts && "projectName" in opts ? (opts.projectName ?? null) : null,
        // Default mirrors the publish repo's seed/default: workspace-shared {commenter,null}.
        // `in` checks so an explicit `null` axis is honored (not coalesced back to commenter).
        workspaceRole: opts && "workspaceRole" in opts ? (opts.workspaceRole ?? null) : "commenter",
        linkRole: opts && "linkRole" in opts ? (opts.linkRole ?? null) : null,
      };
    },
  };
  return { repo, rows };
}

// Deterministic deps so url/slug assertions are stable.
const fixedSlug = (_t: string) => "payment-spec-v2-abc123";

test("AS-001: publish a valid HTML file → doc with immutable slug + version 1 + /d/:slug link, content stored", async () => {
  const { repo, rows } = fakeRepo();
  // 1.2MB HTML carrying <title>, well under the 5MB cap.
  const html = `<!doctype html><html><head><title>Payment Spec v2</title></head><body>${"x".repeat(1_200_000)}</body></html>`;
  const res = await publishDoc(
    { bytes: enc(html), filename: "spec.html" },
    { repo, slugGen: fixedSlug },
  );

  expect(res.kind).toBe("html");
  expect(res.version).toBe(1);
  expect(res.slug).toBe("payment-spec-v2-abc123");
  expect(res.url).toBe("/d/payment-spec-v2-abc123");
  expect(res.docId).toBe("doc-1");

  // Side effect: exactly one doc created, at version 1, with the content persisted.
  expect(rows).toHaveLength(1);
  expect(rows[0].version).toBe(1);
  expect(rows[0].kind).toBe("html");
  expect(rows[0].content).toContain("<title>Payment Spec v2</title>");
  expect(rows[0].contentHash).toBeString();
  expect(rows[0].contentHash.length).toBeGreaterThan(0);

  // Boundary edge: content well over 1MB still publishes (cap is 5MB).
  expect(rows[0].content.length).toBeGreaterThan(1_000_000);
});

test("AS-002: publish via paste with format=Markdown → doc kind=markdown + version 1 + link", async () => {
  const { repo, rows } = fakeRepo();
  const md = "# Release Notes\n\n- shipped publish flow\n";
  const res = await publishDoc(
    { bytes: enc(md), declaredKind: "markdown" }, // paste: no filename, explicit format
    { repo, slugGen: () => "release-notes-xyz999" },
  );

  expect(res.kind).toBe("markdown");
  expect(res.version).toBe(1);
  expect(res.url).toBe("/d/release-notes-xyz999");
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("markdown");
  expect(rows[0].content).toBe(md);
  // Title auto-suggested from the H1 when the author doesn't override.
  expect(rows[0].title).toBe("Release Notes");
});

test("AS-003: title auto-derived (<title>/H1/filename) and editable before publish", () => {
  // HTML: prefer <title>, else first H1.
  expect(deriveTitle("html", "<title>Payment Spec v2</title><h1>Other</h1>")).toBe("Payment Spec v2");
  expect(deriveTitle("html", "<h1>Only An H1</h1>")).toBe("Only An H1");
  // Markdown: first H1 (ATX).
  expect(deriveTitle("markdown", "# Release Notes\nbody")).toBe("Release Notes");
  // Image: file name without extension — first char capitalized (AS-003).
  expect(deriveTitle("image", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "diagrams/flow.png")).toBe("Flow");
  // First char of an auto-derived title is always uppercased; the rest is left as-is.
  expect(deriveTitle("markdown", "# release notes\nbody")).toBe("Release notes");
  expect(deriveTitle("html", "<title>payment spec v2</title>")).toBe("Payment spec v2");

  // Edge — empty / whitespace title falls back, never empty.
  expect(deriveTitle("html", "<title>   </title>")).toBe("Untitled");
  expect(deriveTitle("markdown", "no heading here")).toBe("Untitled");
  // Edge — trimmed.
  expect(deriveTitle("html", "<title>  Spaced  </title>")).toBe("Spaced");
  // Edge — unicode title survives.
  expect(deriveTitle("html", "<title>Báo cáo Quý 2</title>")).toBe("Báo cáo Quý 2");

  // Editable: the author's edit overrides the auto-suggested title at publish time.
  return (async () => {
    const { repo, rows } = fakeRepo();
    await publishDoc(
      { bytes: enc("<title>Payment Spec v2</title>"), filename: "s.html", editedTitle: "Payment Spec" },
      { repo, slugGen: fixedSlug },
    );
    expect(rows[0].title).toBe("Payment Spec"); // edited, not the derived "Payment Spec v2"
  })();
});

test("AS-004 / C-003: over-cap artifact is rejected before any doc is created, message has actual size", async () => {
  const { repo, rows } = fakeRepo();
  // 8.1MB of HTML, over the 5MB text cap.
  const big = "x".repeat(Math.floor(8.1 * 1024 * 1024));
  let err: unknown;
  try {
    await publishDoc({ bytes: enc(big), filename: "report.html" }, { repo, slugGen: fixedSlug });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PublishRejected);
  expect((err as Error).message).toContain("8.1MB");
  expect((err as Error).message).toContain("5.0MB");
  // No doc created — reject happened before persistence.
  expect(rows).toHaveLength(0);

  // Boundary: exactly at the cap is allowed; one byte over is rejected.
  expect(() => validateSize("html", MAX_TEXT_BYTES)).not.toThrow();
  expect(() => validateSize("html", MAX_TEXT_BYTES + 1)).toThrow(PublishRejected);
  expect(() => validateSize("image", MAX_IMAGE_BYTES)).not.toThrow();
  expect(() => validateSize("image", MAX_IMAGE_BYTES + 1)).toThrow(PublishRejected);
});

test("AS-005 / C-005: content whose sniffed type contradicts the .html extension is rejected, nothing published", async () => {
  const { repo, rows } = fakeRepo();
  // report.html but the bytes are binary (NUL + non-UTF8) — not real HTML.
  const binary = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x99]);
  let err: unknown;
  try {
    await publishDoc({ bytes: binary, filename: "report.html" }, { repo, slugGen: fixedSlug });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PublishRejected);
  expect(rows).toHaveLength(0);

  // Sniff directly: a PNG payload declared as .html is also a mismatch.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  expect(() => sniffKind("photo.html", png)).toThrow(PublishRejected);

  // Edge — empty content is rejected (nothing to publish).
  expect(() => sniffKind("x.html", new Uint8Array([]))).toThrow(PublishRejected);

  // Special chars: valid UTF-8 with unicode is fine, sniffs as text/markdown.
  expect(sniffKind(undefined, enc("# Tiêu đề 日本語"))).toBe("markdown");

  // A clean PNG with an image extension sniffs as image (positive control).
  expect(sniffKind("flow.png", png)).toBe("image");
});

test("AS-014 / C-006: a whitespace-only artifact is rejected (carries no content)", () => {
  // 0 bytes already rejected (above); whitespace-only TEXT must reject the same way.
  expect(() => sniffKind(undefined, enc("   \n\t  "))).toThrow(PublishRejected);
  expect(() => sniffKind("notes.md", enc("\n\n   \n"))).toThrow(PublishRejected);
  expect(() => sniffKind("paste.html", enc("     "))).toThrow(PublishRejected);
  // Boundary: a single non-whitespace char is NOT empty → accepted (defaults to markdown).
  expect(sniffKind(undefined, enc("x"))).toBe("markdown");
});

test("AS-015 / C-007: ambiguous paste (no format, no filename) defaults to markdown", () => {
  // No declared kind, no filename to infer from, plain text with no HTML markers → markdown.
  expect(sniffKind(undefined, enc("a plain text paragraph"))).toBe("markdown");
  expect(sniffKind(undefined, enc("line one\nline two\n- a bullet"))).toBe("markdown");
});

// ── doc-access-two-axis S-002 (C-007): the publish service no longer plumbs any per-doc
//    access value — the new-doc default (workspace_role=commenter, link_role=null) is FIXED
//    and applied by the publish repo when it creates the share_links row. The full
//    publish→share_links→resolveAccess chain (a member can view+comment, an anon is denied)
//    is asserted against a real Postgres in test/integration/publish-repo.itest.ts (AS-005,
//    AS-006, AS-025), because it spans the write path and the read resolver. ──────────────

test("C-007: the publish service plumbs no general_access / access value into createDocWithV1", async () => {
  // The dropped docs.general_access column must not be written; access is created on the
  // share_links row by the repo with the fixed default, so the service hands the repo NO
  // access field at all (web/workspace path).
  const { repo, rows } = fakeRepo();
  await publishDoc(
    { bytes: enc("# Spec"), declaredKind: "markdown", ownerId: "u_a", workspaceId: "W" },
    { repo, slugGen: fixedSlug, resolveProjectId: async () => "proj_1" },
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toHaveProperty("generalAccess");
});

test("C-007: the seed path (no workspace) also plumbs no access value", async () => {
  const { repo, rows } = fakeRepo();
  await publishDoc({ bytes: enc("# Seed"), declaredKind: "markdown" }, { repo, slugGen: fixedSlug });
  expect(rows[0]).not.toHaveProperty("generalAccess");
});

// ── project-visibility S-004 (C-013 / AS-029): the publish RESPONSE reports the target
//    project + the doc's resulting access LEVEL (deriveLevel of the axes the repo set), so a
//    quick-publish into the default project is never a silent surprise. ────────────────────
test("AS-029: the publish response reports the target project (id + name) AND the resulting access level", async () => {
  // The repo derived {commenter,null} for the (default/public) project → deriveLevel = anyone_in_workspace.
  const { repo } = fakeRepo({ projectName: "Alice's docs", workspaceRole: "commenter", linkRole: null });
  const res = await publishDoc(
    { bytes: enc("# Spec"), declaredKind: "markdown", ownerId: "u_a", workspaceId: "W" },
    { repo, slugGen: fixedSlug, resolveProjectId: async () => "proj_1" },
  );
  expect(res.project).toEqual({ id: "proj_1", name: "Alice's docs" });
  expect(res.access).toBe("anyone_in_workspace");
});

test("AS-029: a doc derived restricted (non-default private project) reports access=restricted", async () => {
  // The repo derived {null,null} for a non-default private project → deriveLevel = restricted.
  const { repo } = fakeRepo({ projectName: "Drafts", workspaceRole: null, linkRole: null });
  const res = await publishDoc(
    { bytes: enc("# Spec"), declaredKind: "markdown", ownerId: "u_a", workspaceId: "W" },
    { repo, slugGen: fixedSlug, resolveProjectId: async () => "proj_priv" },
  );
  expect(res.project).toEqual({ id: "proj_priv", name: "Drafts" });
  expect(res.access).toBe("restricted");
});
