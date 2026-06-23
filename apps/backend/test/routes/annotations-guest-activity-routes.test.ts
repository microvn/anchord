// In-process route test for workspace-activity S-006 / AS-025: guest feedback via a public link
// records a guest actor (actorUserId null, actorName = the guest's supplied name, PLAIN TEXT F-12).
//
// The comment/create emit itself was wired in S-001 (annotations.ts dispatchActivity) — this test
// pins the GUEST branch: an anon on an anyone_with_link + commenter link who creates an annotation
// with a first comment emits ONE `comment` activity row whose actor is the guest name with NO
// account. EMIT GLUE only (no DB): a capturing ActivityRepo + fake annotation/lookup repos.
//
// AS map (workspace-activity S-006):
//   AS-025  guest feedback → `comment` event, actorUserId null, actorName = the guest name (no account)

import { describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import type { SessionResolver } from "../../src/http/auth-gate";
import type { Viewer } from "../../src/sharing/access";
import type { AccessResult } from "../../src/sharing/resolve-access";
import type { Role } from "../../src/sharing/roles";
import type { AnnotationRepo, NewAnnotation, AnnotationRow } from "../../src/annotation/annotation";
import type { CommentRepo } from "../../src/annotation/reply";
import type { GuestCommentRepo, NewGuestComment } from "../../src/annotation/guest";
import type { DocLookup, DocLookupRepo } from "../../src/routes/versions";
import type { NewActivity, ActivityRepo, ActivityRow } from "../../src/activity/repo";

const noSession: SessionResolver = async () => null;

const VISIBLE_DOC: DocLookup = {
  id: "doc_1",
  title: "Render pipeline RFC",
  kind: "markdown",
  generalAccess: "anyone_with_link",
};
const TEXT_ANCHOR = { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 };

// An anon on an anyone_with_link doc whose link role is commenter — the link role IS the grant.
const linkCommenter = async (_docId: string, _viewer: Viewer): Promise<AccessResult> => ({
  role: "commenter" as Role,
  canView: true,
});

function fakeAnnotationRepo() {
  const calls = { comments: [] as { authorId: string | null; guestName: string | null; body: string }[] };
  let n = 0;
  let cn = 0;
  const repo: AnnotationRepo = {
    async insertAnnotation(input: NewAnnotation) {
      return { id: `ann_${++n}` };
    },
    async insertAnnotationWithComment(input, comment) {
      const id = `ann_${++n}`;
      if (comment === undefined) return { id };
      calls.comments.push({ authorId: comment.authorId, guestName: comment.guestName, body: comment.body });
      return { id, commentId: `c_${++cn}` };
    },
    async listByDoc() {
      return [] as AnnotationRow[];
    },
    async listCommentsByDoc() {
      return [];
    },
  };
  return { repo, calls };
}

const fakeCommentRepo: CommentRepo = {
  async listByAnnotation() {
    return [];
  },
  async insertComment(input) {
    return { id: "c_x" };
  },
};

const fakeGuestCommentRepo: GuestCommentRepo = {
  async listByAnnotation() {
    return [];
  },
  async insertComment(_input: NewGuestComment) {
    return { id: "g_1" };
  },
};

const fakeLookup: DocLookupRepo = {
  async findDocBySlug() {
    return VISIBLE_DOC;
  },
  async getVersionContent() {
    return null;
  },
};

function fakeActivityRepo() {
  const rows: NewActivity[] = [];
  let seq = 0;
  const repo: ActivityRepo = {
    async insertActivity(input) {
      rows.push(input);
      return { id: `act_${++seq}` };
    },
    async countActivity() {
      return rows.length;
    },
    async listActivity() {
      return [] as ActivityRow[];
    },
    async listAllActivity() {
      return [] as ActivityRow[];
    },
    async getActivityById() {
      return null;
    },
    async listRelatedByDoc() {
      return [] as ActivityRow[];
    },
  };
  return { repo, rows };
}

function buildApp(act: ReturnType<typeof fakeActivityRepo>) {
  const ar = fakeAnnotationRepo();
  const app = createApp({
    dbCheck: async () => {},
    annotations: {
      annotationRepo: ar.repo,
      commentRepo: fakeCommentRepo,
      guestCommentRepo: fakeGuestCommentRepo,
      resolutionRepo: { async setAnnotationStatus() {}, async resetSuggestionStatusToPending() {} },
      deleteRepo: { async setDeletedAt() {} },
      restoreRepo: { async clearDeletedAt() {} },
      dismissReattachRepo: { async dismiss() {}, async reattach() {} },
      suggestionRepo: {
        async insertSuggestion() {
          return { id: "s" };
        },
        async getSuggestion() {
          return null;
        },
        async setSuggestionStatus() {},
      },
      lookupRepo: fakeLookup,
      annotationLookupRepo: {
        async findAnnotationDoc() {
          return null;
        },
        async findSuggestionDoc() {
          return null;
        },
        async getCurrentVersionContent() {
          return null;
        },
        async getCurrentVersion() {
          return null;
        },
      },
      resolveSession: noSession,
      resolveWorkspaceRole: async () => "member",
      resolveDocRole: async () => null,
      resolveAccess: linkCommenter,
      activity: {
        repo: act.repo,
        workspaceOfDoc: async () => "ws_1",
        // No account → never consulted for a guest; returns null defensively.
        resolveActorName: async () => null,
      },
    },
  });
  return { app, ar };
}

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    ...init,
  });
}

describe("workspace-activity S-006: guest feedback records a guest actor (AS-025)", () => {
  test("AS-025/F-12: a no-account guest leaving feedback via a public link emits a comment event with actorName = the guest name and NO account", async () => {
    const act = fakeActivityRepo();
    const { app, ar } = buildApp(act);
    const res = await app.handle(
      req("/api/docs/render-pipeline-rfc/annotations", {
        method: "POST",
        body: JSON.stringify({ anchor: TEXT_ANCHOR, comment: { body: "guest feedback", guestName: "Anonymous Heron" } }),
      }),
    );
    expect(res.status).toBe(201);
    // The guest comment persisted with a null durable author + the guest name.
    expect(ar.calls.comments).toHaveLength(1);
    expect(ar.calls.comments[0]?.authorId).toBeNull();

    // The activity row records the guest actor: no account, the guest's supplied name (plain text).
    const comments = act.rows.filter((r) => r.type === "comment");
    expect(comments).toHaveLength(1);
    const row = comments[0];
    expect(row.actorUserId).toBeNull();
    expect(row.actorName).toBe("Anonymous Heron");
    expect(row.docId).toBe("doc_1");
    expect(row.workspaceId).toBe("ws_1");
  });
});
