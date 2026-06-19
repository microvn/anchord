// mcp-roundtrip S-002 — concrete Drizzle/service wiring for the publish tools.
//
// Maps the tools' injectable ports onto the EXISTING domain services (no new behaviour):
//   • create → publish/service.ts `publishDoc` with the workspace-scoped
//     `createPublishProjectResolver` (AS-003 default-project fallback / AS-018 explicit /
//     AS-019 foreign-rejected) — restricted general_access is the docs column default (C-006).
//   • update → services/version-repo.ts `appendVersionTx` (per-doc advisory lock +
//     UNIQUE(doc_id, version) backstop = C-011) + the doc lookup + resolveAccess role gate
//     + the same re-anchor seam routes/versions.ts fires (C-012).
//
// This module is THIN glue (the integration-verified-later layer); the testable logic is
// in publish-tools.ts. Kept separate so the unit suite never needs a DB.

import { eq } from "drizzle-orm";
import { docs } from "../../db/schema";
import type { DB } from "../../db/client";
import { publishDoc } from "../../publish/service";
import { createDocRepo } from "../../publish/repo";
import { createPublishProjectResolver } from "../../workspace/repo";
import { appendVersionTx } from "../../services/version-repo";
import type { Viewer } from "../../sharing/access";
import type { AccessResult } from "../../sharing/resolve-access";
import type { Role } from "../../sharing/roles";
import {
  publishTools,
  type CreateDocumentPort,
  type UpdateDocumentPorts,
  type UpdateTargetDoc,
} from "./publish-tools";
import type { ToolDef } from "../server";

/**
 * Concrete create port over `publishDoc`. The agent passes a content STRING + a format;
 * publishDoc takes bytes + a declaredKind, so we encode here. The project resolver is the
 * workspace-scoped publish resolver — it honors an explicit writable projectId, rejects a
 * foreign/invalid one (throws ProjectRejected → surfaces as a tool error), and falls back
 * to the owner's default project when omitted (C-006).
 */
export function createMcpCreateDocumentPort(db: DB): CreateDocumentPort {
  const repo = createDocRepo(db);
  const resolveProjectId = createPublishProjectResolver(db);
  return async (input) => {
    const res = await publishDoc(
      {
        bytes: new TextEncoder().encode(input.content),
        declaredKind: input.format as "html" | "markdown",
        editedTitle: input.title,
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      { repo, resolveProjectId },
    );
    // C-006: the doc is created restricted (docs.general_access column default) — no
    // visibility is ever set via MCP in v0. Return the agent-facing shape (AS-003.T4).
    return { docId: res.docId, slug: res.slug, url: res.url };
  };
}

/**
 * Concrete update ports. `resolveAccess` is the single authoritative gate (doc-access-routing
 * S-001); appendVersionTx is the per-doc-serialized append (C-011); fireReanchor reuses the
 * same async seam index.ts wires for routes/versions.ts (C-012).
 */
export function createMcpUpdateDocumentPorts(deps: {
  db: DB;
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  reanchorOnNewVersion?: (input: {
    docId: string;
    version: number;
    newContentHtml: string;
  }) => Promise<unknown> | unknown;
}): UpdateDocumentPorts {
  return {
    async findDocById(docId: string): Promise<UpdateTargetDoc | null> {
      const [row] = await deps.db
        .select({ id: docs.id, kind: docs.kind })
        .from(docs)
        .where(eq(docs.id, docId))
        .limit(1);
      return row ?? null;
    },
    async resolveRole(docId: string, userId: string): Promise<Role | null> {
      const viewer: Viewer = { kind: "user", userId };
      const { role } = await deps.resolveAccess(docId, viewer);
      return role;
    },
    async appendVersion(input) {
      const contentHash = sha256Hex(input.content);
      const { version, previousVersion } = await appendVersionTx(
        deps.db,
        input.docId,
        input.content,
        contentHash,
        input.publishedBy,
        input.kind,
      );
      return { version, previousVersion };
    },
    fireReanchor(input) {
      // C-012: fire-and-forget — never await, swallow rejection (best-effort; the job
      // logs/alerts on its own). A failed run leaves annotations PREVIOUS + is retried.
      if (!deps.reanchorOnNewVersion) return;
      void Promise.resolve(deps.reanchorOnNewVersion(input)).catch(() => {});
    },
  };
}

function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new TextEncoder().encode(text));
  return hasher.digest("hex");
}

/** Build the concrete publish tool registry fragment for the MCP server. */
export function createPublishToolsForDb(deps: {
  db: DB;
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  reanchorOnNewVersion?: (input: {
    docId: string;
    version: number;
    newContentHtml: string;
  }) => Promise<unknown> | unknown;
}): Record<string, ToolDef> {
  return publishTools({
    create: createMcpCreateDocumentPort(deps.db),
    update: createMcpUpdateDocumentPorts({
      db: deps.db,
      resolveAccess: deps.resolveAccess,
      reanchorOnNewVersion: deps.reanchorOnNewVersion,
    }),
  });
}
