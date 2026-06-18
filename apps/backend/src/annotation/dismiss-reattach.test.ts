import { test, expect } from "bun:test";
import {
  dismissAnnotation,
  reattachAnnotation,
  type DismissReattachRepo,
} from "./dismiss-reattach";
import type { Anchor } from "./annotation";

// annotation-core S-008 — dismiss / re-attach a DETACHED annotation. Pure authz (C-013:
// comment permission or higher) + the dismiss / re-attach writes against a fake repo (mirrors
// delete.test.ts). The route owns session-required + existence-hiding 404 + parent-doc binding;
// this module owns the comment-permission gate (AS-025 viewer refused) and the writes, plus the
// re-attach anchor-placement validation (AS-024 the range must be in the current version).

const ANCHOR: Anchor = { blockId: "block-p-1", textSnippet: "hello", offset: 0, length: 5 };

// A fake repo recording every dismiss + re-attach so a no-op (forbidden / mismatch) path is
// observable — the annotation must be untouched when the caller is a viewer or the anchor misses.
function fakeRepo(): DismissReattachRepo & { dismissed: string[]; reattached: { id: string; anchor: Anchor }[] } {
  const dismissed: string[] = [];
  const reattached: { id: string; anchor: Anchor }[] = [];
  return {
    get dismissed() {
      return dismissed;
    },
    get reattached() {
      return reattached;
    },
    async dismiss(annotationId: string) {
      dismissed.push(annotationId);
    },
    async reattach(annotationId: string, anchor: Anchor) {
      reattached.push({ id: annotationId, anchor });
    },
  };
}

const placesAlways = () => true;
const placesNever = () => false;

// ── AS-023: dismiss a detached annotation ──────────────────────────────────

test("AS-023: a commenter dismisses a detached annotation → soft-dismissed (the marker write fired)", async () => {
  // Given a detached annotation and a caller with comment permission.
  const repo = fakeRepo();
  const res = await dismissAnnotation({ annotationId: "ann-orph", sessionRole: "commenter" }, repo);
  // Then it is dismissed (the dismissed_at write fired for this id) — kept, not hard-deleted (the
  // repo only stamps the marker; there is no delete call). The active-read exclusion is the repo's.
  expect(res).toEqual({ ok: true });
  expect(repo.dismissed).toEqual(["ann-orph"]);
});

test("AS-023: an editor and an owner may also dismiss (comment permission or higher)", async () => {
  const editorRepo = fakeRepo();
  expect(await dismissAnnotation({ annotationId: "a1", sessionRole: "editor" }, editorRepo)).toEqual({ ok: true });
  expect(editorRepo.dismissed).toEqual(["a1"]);

  const ownerRepo = fakeRepo();
  expect(await dismissAnnotation({ annotationId: "a2", sessionRole: "owner" }, ownerRepo)).toEqual({ ok: true });
  expect(ownerRepo.dismissed).toEqual(["a2"]);
});

// ── AS-024: re-attach a detached annotation to a new range ──────────────────

test("AS-024: a commenter re-attaches onto a matching range → is_orphaned cleared + anchor set to the new range", async () => {
  // Given a detached annotation and a fresh range that PLACES against the current version.
  const repo = fakeRepo();
  const newRange: Anchor = { blockId: "block-p-2", textSnippet: "world", offset: 6, length: 5 };
  const res = await reattachAnnotation(
    { annotationId: "ann-orph", anchor: newRange, sessionRole: "commenter" },
    placesAlways,
    repo,
  );
  // Then it returns anchored: the repo clears is_orphaned and sets the NEW anchor (the repo write
  // carries exactly the submitted range, so the annotation re-anchors at the selected block/snippet/offset).
  expect(res).toEqual({ ok: true });
  expect(repo.reattached).toEqual([{ id: "ann-orph", anchor: newRange }]);
});

test("AS-024: re-attach with an anchor that doesn't match the current version → refused (anchor_mismatch), unchanged", async () => {
  // Error path: the selected range places against NO block/snippet in the current version.
  const repo = fakeRepo();
  const res = await reattachAnnotation(
    { annotationId: "ann-orph", anchor: ANCHOR, sessionRole: "commenter" },
    placesNever,
    repo,
  );
  // Then refused as a mismatch (the route 400s); the repo is never written (annotation unchanged).
  expect(res).toEqual({ ok: false, reason: "anchor_mismatch" });
  expect(repo.reattached).toHaveLength(0);
});

// ── AS-025: re-attach / dismiss without comment permission is refused ───────

test("AS-025: a viewer cannot dismiss → refused, annotation unchanged", async () => {
  const repo = fakeRepo();
  const res = await dismissAnnotation({ annotationId: "ann-orph", sessionRole: "viewer" }, repo);
  expect(res).toEqual({ ok: false, reason: "forbidden" });
  expect(repo.dismissed).toHaveLength(0); // never written
});

test("AS-025: a viewer cannot re-attach → refused BEFORE the anchor check, annotation unchanged", async () => {
  // The viewer refusal precedes the anchor-placement check: even a perfectly-matching anchor
  // (placesAlways) must NOT be written, and the 403 must not leak whether the anchor would match.
  const repo = fakeRepo();
  const res = await reattachAnnotation(
    { annotationId: "ann-orph", anchor: ANCHOR, sessionRole: "viewer" },
    placesAlways,
    repo,
  );
  expect(res).toEqual({ ok: false, reason: "forbidden" });
  expect(repo.reattached).toHaveLength(0); // unchanged
});

// ── C-013: dismiss(soft)/reattach(clear+anchor), commenter+, viewer refused ─

test("C-013: dismiss is soft (marker only, no hard-delete) and re-attach clears is_orphaned + sets the fresh anchor; both commenter+", async () => {
  // dismiss = soft: the repo's only mutation is the dismiss marker — there is no delete on the port.
  const dRepo = fakeRepo();
  await dismissAnnotation({ annotationId: "ann-c13", sessionRole: "commenter" }, dRepo);
  expect(dRepo.dismissed).toEqual(["ann-c13"]); // kept (soft), not hard-deleted
  expect(dRepo.reattached).toHaveLength(0);

  // re-attach = clear is_orphaned + set the fresh anchor (the repo applies both).
  const rRepo = fakeRepo();
  const fresh: Anchor = { blockId: "block-h-1", textSnippet: "Intro", offset: 0, length: 5 };
  await reattachAnnotation({ annotationId: "ann-c13", anchor: fresh, sessionRole: "commenter" }, placesAlways, rRepo);
  expect(rRepo.reattached).toEqual([{ id: "ann-c13", anchor: fresh }]);
});
