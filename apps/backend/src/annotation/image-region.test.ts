import { test, expect } from "bun:test";
import {
  pointRegion,
  boxRegion,
  denormalizePoint,
  imageRegionAnchor,
  createImageRegionAnnotation,
} from "./image-region";
import type { AnnotationRepo, AnnotationRow, NewAnnotation } from "./annotation";
import type { Rect } from "../render/image";
import type { Viewer } from "../sharing/access";

// annotation-core S-002 — image-region geometry (point/box normalized 0..1 against the
// ORIGINAL image) + the create path through S-001 createAnnotation. Pure logic against a
// fake repo, mirroring annotation.test.ts. The click/drag capture and pin/box overlay are
// FRONTEND [→MANUAL]; this covers the durable coordinate contract (C-006) + create authz.

function fakeRepo(seed: AnnotationRow[] = []): AnnotationRepo & { inserted: NewAnnotation[] } {
  const inserted: NewAnnotation[] = [];
  return {
    inserted,
    async insertAnnotation(input: NewAnnotation) {
      inserted.push(input);
      return { id: `ann-${inserted.length}` };
    },
    async listByDoc(_docId: string) {
      return seed;
    },
    async listCommentsByDoc(_docId: string) {
      return [];
    },
  };
}

const commenter: Viewer = { kind: "user", userId: "u-commenter" };

// A 1000x800 image laid out at viewport origin (100, 50). A click at ~ (0.4, 0.6) of the
// original image is therefore at clientX = 100 + 0.4*1000 = 500, clientY = 50 + 0.6*800 = 530.
const rect: Rect = { left: 100, top: 50, width: 1000, height: 800 };

const approx = (got: number, want: number, eps = 1e-9) => expect(Math.abs(got - want)).toBeLessThan(eps);

test("AS-005: pin a point on an image stores normalized 0..1 coords relative to the original image", async () => {
  // Click at ~ (0.4, 0.6) of the original image (spec Data).
  const region = pointRegion(500, 530, rect);

  expect(region.kind).toBe("point");
  approx(region.x, 0.4);
  approx(region.y, 0.6);
  // Normalized: both within 0..1.
  expect(region.x).toBeGreaterThanOrEqual(0);
  expect(region.x).toBeLessThanOrEqual(1);
  expect(region.y).toBeGreaterThanOrEqual(0);
  expect(region.y).toBeLessThanOrEqual(1);

  // Create path: stored anchor carries the point region, persisted via S-001.
  const repo = fakeRepo();
  const res = await createImageRegionAnnotation(
    { docId: "doc-img", blockId: "img-1", region, viewer: commenter, sessionRole: "commenter" },
    repo,
  );
  expect(res).toEqual({ created: true, id: "ann-1" });
  expect(repo.inserted[0]!.anchor.region).toEqual({ kind: "point", x: region.x, y: region.y });
  expect(repo.inserted[0]!.type).toBe("block");
});

test("AS-005: a point clicked outside the image clamps into 0..1 (boundary)", () => {
  // Far below-right of the image → clamps to (1, 1), never out of range.
  const region = pointRegion(99999, 99999, rect);
  expect(region).toEqual({ kind: "point", x: 1, y: 1 });
  // Far above-left → clamps to (0, 0).
  expect(pointRegion(-99999, -99999, rect)).toEqual({ kind: "point", x: 0, y: 0 });
});

test("AS-006: box a region by drag stores normalized coords (x,y,w,h)", async () => {
  // Box (0.1,0.1)–(0.5,0.4) of the original image (spec Data).
  // start: 100 + 0.1*1000 = 200, 50 + 0.1*800 = 130.
  // end:   100 + 0.5*1000 = 600, 50 + 0.4*800 = 370.
  const region = boxRegion(
    { clientX: 200, clientY: 130 },
    { clientX: 600, clientY: 370 },
    rect,
  );

  expect(region.kind).toBe("box");
  approx(region.x, 0.1);
  approx(region.y, 0.1);
  approx(region.w, 0.4); // 0.5 - 0.1
  approx(region.h, 0.3); // 0.4 - 0.1
  // x+w and y+h stay within the image.
  expect(region.x + region.w).toBeLessThanOrEqual(1 + 1e-9);
  expect(region.y + region.h).toBeLessThanOrEqual(1 + 1e-9);

  const repo = fakeRepo();
  const res = await createImageRegionAnnotation(
    { docId: "doc-img", blockId: "img-1", region, viewer: commenter, sessionRole: "commenter" },
    repo,
  );
  expect(res).toEqual({ created: true, id: "ann-1" });
  expect(repo.inserted[0]!.anchor.region).toEqual(region);
});

test("AS-006: a box dragged bottom-right→top-left normalizes to the same region (direction-independent)", () => {
  const forward = boxRegion({ clientX: 200, clientY: 130 }, { clientX: 600, clientY: 370 }, rect);
  const reverse = boxRegion({ clientX: 600, clientY: 370 }, { clientX: 200, clientY: 130 }, rect);
  // Same top-left + same size regardless of which corner the drag started at.
  approx(reverse.x, forward.x);
  approx(reverse.y, forward.y);
  approx(reverse.w, forward.w);
  approx(reverse.h, forward.h);
});

test("AS-006: a zero-distance drag yields a zero-size box (empty/degenerate)", () => {
  const region = boxRegion({ clientX: 500, clientY: 530 }, { clientX: 500, clientY: 530 }, rect);
  approx(region.w, 0);
  approx(region.h, 0);
  approx(region.x, 0.4);
  approx(region.y, 0.6);
});

test("AS-007: a stored pin stays in place across zoom 200% then 50% (normalized coords don't drift)", () => {
  // Create the pin once against a base rect (the spec's "already created" pin).
  const stored = pointRegion(500, 530, rect); // ~ (0.4, 0.6)

  // Zoomed 200%: image is twice as large, and the viewport origin shifts (pan). The
  // STORED normalized coords are unchanged — the pin lives on the original image.
  const zoom200: Rect = { left: -300, top: -150, width: 2000, height: 1600 };
  // Zoomed 50%: half size, different origin.
  const zoom50: Rect = { left: 250, top: 200, width: 500, height: 400 };
  // Different screen size entirely (mobile).
  const mobile: Rect = { left: 0, top: 0, width: 360, height: 288 };

  // 1) The stored coords themselves never change — no drift.
  approx(stored.x, 0.4);
  approx(stored.y, 0.6);

  // 2) Round-trip stability: denormalize onto a rect, re-normalize, and the SAME 0..1
  //    coords come back for every rect. This proves the mark is durable across zoom/screen.
  for (const r of [rect, zoom200, zoom50, mobile]) {
    const px = denormalizePoint(stored, r);
    const back = pointRegion(px.x, px.y, r);
    approx(back.x, stored.x);
    approx(back.y, stored.y);
  }

  // 3) And each rect maps the stored point to the geometrically correct on-screen pixel:
  //    left + x*width, top + y*height.
  approx(denormalizePoint(stored, zoom200).x, -300 + 0.4 * 2000); // 500
  approx(denormalizePoint(stored, zoom200).y, -150 + 0.6 * 1600); // 810
  approx(denormalizePoint(stored, zoom50).x, 250 + 0.4 * 500); // 450
  approx(denormalizePoint(stored, zoom50).y, 200 + 0.6 * 400); // 440
});

test("C-006: image-region anchor stores a portable normalized 0..1 record relative to the original image", () => {
  const point = imageRegionAnchor("img-1", { kind: "point", x: 0.4, y: 0.6 });
  expect(point.region).toEqual({ kind: "point", x: 0.4, y: 0.6 });
  // No text payload on an image anchor.
  expect(point.textSnippet).toBe("");
  expect(point.offset).toBe(0);
  expect(point.length).toBe(0);

  const box = imageRegionAnchor("img-1", { kind: "box", x: 0.1, y: 0.1, w: 0.4, h: 0.3 });
  expect(box.region).toEqual({ kind: "box", x: 0.1, y: 0.1, w: 0.4, h: 0.3 });

  // Portable: the region survives a JSON round-trip unchanged (it is the jsonb shape).
  expect(JSON.parse(JSON.stringify(box.region))).toEqual(box.region);
});

test("C-006: an image-region create is gated by the server session role, not the iframe (forbidden for viewer)", async () => {
  const repo = fakeRepo();
  const res = await createImageRegionAnnotation(
    {
      docId: "doc-img",
      blockId: "img-1",
      region: { kind: "point", x: 0.4, y: 0.6 },
      viewer: commenter,
      sessionRole: "viewer", // server-resolved viewer cannot comment
    },
    repo,
  );
  expect(res).toEqual({ created: false, reason: "forbidden" });
  expect(repo.inserted).toHaveLength(0);
});
