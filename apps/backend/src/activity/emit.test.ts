// Unit tests for the best-effort activity emit + the read-repo filter shape + the schema/enum
// guarantees (workspace-activity S-001). Pure logic with fakes — no DB.

import { describe, expect, test } from "bun:test";
import { emitActivity, SYSTEM_ACTOR_NAME, type ActivityEmitDeps } from "./emit";
import type { ActivityRepo, NewActivity, ActivityFilter } from "./repo";
import { activityType } from "../db/schema";
import type { ActivityType } from "./types";

// A fake repo recording inserts; can be made to throw to exercise the best-effort swallow.
function fakeRepo(opts: { throwOnInsert?: boolean } = {}): ActivityRepo & { inserted: NewActivity[] } {
  const inserted: NewActivity[] = [];
  return {
    inserted,
    async insertActivity(input) {
      if (opts.throwOnInsert) throw new Error("activity write unavailable");
      inserted.push(input);
      return { id: `act-${inserted.length}` };
    },
    async countActivity() {
      return inserted.length;
    },
    async listActivity() {
      return [];
    },
    async listAllActivity() {
      return [];
    },
    async getActivityById() {
      return null;
    },
  };
}

const baseDeps = (repo: ActivityRepo, over: Partial<ActivityEmitDeps> = {}): ActivityEmitDeps => ({
  repo,
  workspaceOfDoc: async () => "ws-1",
  resolveActorName: async () => "Devin",
  logError: () => {},
  ...over,
});

describe("emitActivity (workspace-activity S-001)", () => {
  test("AS-006 / C-002: a failed activity write is swallowed (never throws) and writes nothing", async () => {
    const repo = fakeRepo({ throwOnInsert: true });
    // The mutation already committed; emit must NOT propagate the repo failure.
    let threw = false;
    let result: unknown;
    try {
      result = await emitActivity(
        { type: "comment", actorUserId: "u-devin", docId: "d-1", annotationId: "a-1", commentId: "c-1" },
        baseDeps(repo),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // best-effort: a logging failure never blocks the originating action
    expect(result).toBeNull(); // nothing written → null
    expect(repo.inserted).toHaveLength(0);
  });

  test("C-008: a doc-scoped emit anchors workspaceId to the doc's OWN workspace, not the caller", async () => {
    const repo = fakeRepo();
    // workspaceOfDoc returns the doc's real owner workspace — that is what lands on the row.
    await emitActivity(
      { type: "comment", actorUserId: "u-devin", docId: "d-1", annotationId: "a-1", commentId: "c-1" },
      baseDeps(repo, { workspaceOfDoc: async () => "ws-OWNER" }),
    );
    expect(repo.inserted).toHaveLength(1);
    expect(repo.inserted[0].workspaceId).toBe("ws-OWNER");
    expect(repo.inserted[0].actorName).toBe("Devin"); // resolved from resolveActorName
    expect(repo.inserted[0].type).toBe("comment");
  });

  test("C-008: a doc with no resolvable workspace skips the write (best-effort), never throws", async () => {
    const repo = fakeRepo();
    const result = await emitActivity(
      { type: "comment", actorUserId: "u-devin", docId: "d-orphan", annotationId: "a-1" },
      baseDeps(repo, { workspaceOfDoc: async () => null }),
    );
    expect(result).toBeNull();
    expect(repo.inserted).toHaveLength(0); // no workspace → can't place in a feed → skip
  });

  test("C-002: an explicit guest actorName is stored verbatim (plain text); a null actor → System", async () => {
    const repo = fakeRepo();
    // Guest action: no account (null userId), an explicit supplied name.
    await emitActivity(
      { type: "comment", actorUserId: null, actorName: "Anonymous Heron", docId: "d-1", annotationId: "a-1" },
      baseDeps(repo),
    );
    // System action: null actor, no name → falls back to "System".
    await emitActivity(
      { type: "detached", actorUserId: null, docId: "d-1" },
      baseDeps(repo, { resolveActorName: async () => null }),
    );
    expect(repo.inserted[0].actorName).toBe("Anonymous Heron");
    expect(repo.inserted[0].actorUserId).toBeNull();
    expect(repo.inserted[1].actorName).toBe(SYSTEM_ACTOR_NAME);
  });

  test("C-005: exactly twelve activity event types are defined in the enum", () => {
    const expected: ActivityType[] = [
      "comment",
      "reply",
      "resolve",
      "publish",
      "restore",
      "share",
      "invite",
      "member",
      "member_removed",
      "workspace_renamed",
      "project",
      "detached",
    ];
    // The pgEnum exposes its values — assert the set is exactly the twelve, no more, no fewer.
    expect([...activityType.enumValues].sort()).toEqual([...expected].sort());
    expect(activityType.enumValues).toHaveLength(12);
  });
});

// C-001 (schema-level): the activity table is append-only with the F-1 delete behaviour baked in —
// comment_id / annotation_id SET NULL on delete (the event row survives), but doc_id is RETAINED
// (no FK, never set-null) so a deleted doc's event keeps its doc_id and the read-time filter still
// gates it. We assert the SHAPE here (the migration encodes the actual ON DELETE rules); the full
// deleted-target degrade behaviour is a later story (AS-018).
describe("activity schema shape (workspace-activity S-001, C-001)", () => {
  test("C-001: docId is a retained column; commentId/annotationId are present (set-null on delete)", async () => {
    const { activity } = await import("../db/schema");
    const t = activity as unknown as Record<string, { name?: string }>;
    // doc_id is a plain text column (no FK → retained on doc delete, F-1): its DB column name is doc_id.
    expect(t.docId?.name).toBe("doc_id");
    // comment_id / annotation_id exist as the SET-NULL deep-link refs (so the row survives a delete).
    expect(t.commentId?.name).toBe("comment_id");
    expect(t.annotationId?.name).toBe("annotation_id");
    // workspace_id is the required owning-scope column.
    expect(t.workspaceId?.name).toBe("workspace_id");
  });

  test("C-001: the migration sets comment_id/annotation_id ON DELETE set null but gives doc_id NO FK (retained)", async () => {
    // The generated drizzle migration is the source of truth for ON DELETE rules. Read the activity
    // migration and assert the F-1 invariant at the SQL level.
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../../drizzle/", import.meta.url).pathname;
    const file = readdirSync(dir).find((f) => {
      try {
        return /\.sql$/.test(f) && readFileSync(dir + f, "utf8").includes('CREATE TABLE "activity"');
      } catch {
        return false;
      }
    });
    expect(file).toBeTruthy();
    const sql = readFileSync(dir + file!, "utf8");
    // comment_id + annotation_id → SET NULL FKs (the event row survives the referenced delete).
    expect(sql).toMatch(/activity_comment_id_comments_id_fk[\s\S]*?ON DELETE set null/);
    expect(sql).toMatch(/activity_annotation_id_annotations_id_fk[\s\S]*?ON DELETE set null/);
    // doc_id has NO foreign key at all (retained on doc delete, F-1 — never reclassified workspace-level).
    expect(sql).not.toContain("activity_doc_id_");
  });
});
