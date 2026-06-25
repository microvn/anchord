import { describe, expect, test } from "bun:test";
import { deriveWorkspace, genericizeIfDeleted, type DeepLinkFields } from "./read-repo";

// your-activity-inbox S-001 (BE-enrich): focused unit coverage of the per-row workspace derivation
// the cross-workspace For-you inbox renders its chip from (AS-003). The full multi-join read is
// exercised against a real Postgres in test/integration/notify-panel-enrichment.itest.ts (the seam
// still needs integration verification — the join itself can only be proven against a DB); these
// tests pin the pure precedence/NULL-safety rules without one.

describe("deriveWorkspace (your-activity-inbox S-001)", () => {
  test("AS-003: a doc-backed row takes the workspace from the doc→project→workspace chain", () => {
    const out = deriveWorkspace({
      type: "reply",
      refId: "ann-1",
      refLabel: null,
      docWorkspaceId: "ws-acme",
      docWorkspaceName: "Acme Platform",
    });
    expect(out).toEqual({ workspaceId: "ws-acme", workspaceName: "Acme Platform" });
  });

  test("BE-enrich: a workspace_invited row takes workspaceId from refId + name from refLabel", () => {
    const out = deriveWorkspace({
      type: "workspace_invited",
      refId: "ws-field",
      refLabel: "Field IO",
      docWorkspaceId: null,
      docWorkspaceName: null,
    });
    // refId IS the workspace id; refLabel is the emit-time name snapshot (no live join).
    expect(out).toEqual({ workspaceId: "ws-field", workspaceName: "Field IO" });
  });

  test("BE-enrich: every workspace_* membership type derives off refId/refLabel", () => {
    for (const type of [
      "workspace_member_joined",
      "workspace_member_removed",
      "workspace_renamed",
    ] as const) {
      const out = deriveWorkspace({
        type,
        refId: "ws-x",
        refLabel: "X Team",
        docWorkspaceId: null,
        docWorkspaceName: null,
      });
      expect(out).toEqual({ workspaceId: "ws-x", workspaceName: "X Team" });
    }
  });

  test("BE-enrich: the doc chain WINS over a workspace_* fallback when both could apply", () => {
    // A doc chain present always takes precedence — refId is never read as a workspace id for a row
    // that resolved a real doc workspace.
    const out = deriveWorkspace({
      type: "reply",
      refId: "ann-2",
      refLabel: "stale label",
      docWorkspaceId: "ws-real",
      docWorkspaceName: "Real WS",
    });
    expect(out).toEqual({ workspaceId: "ws-real", workspaceName: "Real WS" });
  });

  test("BE-enrich: a doc-less, non-workspace row resolves to null/null (NULL-safe, no chip)", () => {
    const out = deriveWorkspace({
      type: "invited",
      refId: "ws-doc-share",
      refLabel: null,
      docWorkspaceId: null,
      docWorkspaceName: null,
    });
    expect(out).toEqual({ workspaceId: null, workspaceName: null });
  });

  test("BE-enrich: a doc-backed row with a resolved id but null name keeps the id, nulls the name", () => {
    const out = deriveWorkspace({
      type: "new_feedback",
      refId: "ann-3",
      refLabel: null,
      docWorkspaceId: "ws-acme",
      docWorkspaceName: null,
    });
    expect(out).toEqual({ workspaceId: "ws-acme", workspaceName: null });
  });
});

// doc-delete-trash S-006 / C-010 (AS-033): a notification's deep-link enrichment reads the doc title,
// the anchored quote, and the comment body/author off a RAW refId→annotation→doc chain (not the gated
// viewer). When that doc is soft-deleted, none of those may surface in the bell payload — the row
// must fall back to its generic per-type summary and the deep-link must degrade (no slug to build a
// `/d/:slug` route from). The actual click-through still routes through the S-004 gated viewer.
describe("genericizeIfDeleted (doc-delete-trash S-006 / C-010)", () => {
  const LIVE: DeepLinkFields = {
    slug: "spec-v1-ab12",
    docTitle: "Spec v1",
    quote: "the anchored sentence",
    snippet: "please revise this section",
    actorName: "Mai",
  };

  test("AS-033: a LIVE doc passes its deep-link + content fields through unchanged", () => {
    expect(genericizeIfDeleted(LIVE, false)).toEqual(LIVE);
  });

  test("AS-033: a DELETED doc nulls EVERY content field — no title/anchor/comment leak, no slug to deep-link", () => {
    const out = genericizeIfDeleted(LIVE, true);
    // No raw content reaches the bell payload: the row keeps only its generic per-type summary.
    expect(out).toEqual({ slug: null, docTitle: null, quote: null, snippet: null, actorName: null });
    // The deep-link target is gone: with slug null the FE cannot build `/d/:slug#annotation-:id`, so
    // the only way to the doc is the gated viewer route (S-004) — never a raw id-keyed content read.
    expect(out.slug).toBeNull();
    expect(out.docTitle).toBeNull();
  });
});
