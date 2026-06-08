// Image-region annotation geometry (annotation-core S-002). A point (click) or box
// (drag) marked on an image, stored as coordinates normalized 0..1 against the ORIGINAL
// image so the mark never drifts across zoom / screen-size changes (C-006, AS-007).
//
// The click/drag capture, the pin/box overlay rendering, and the zoom/pan chrome are
// FRONTEND [→MANUAL]; this module owns the coordinate math (the durable contract) and
// the create-path: it builds an image-region Anchor that goes through the S-001
// createAnnotation server-re-auth path, reusing render/image.ts normalizePoint so the
// normalization that backs AS-007 has ONE implementation, not two.

import { normalizePoint, type Rect } from "../render/image";
import {
  createAnnotation,
  type Anchor,
  type AnnotationRepo,
  type CreateAnnotationResult,
} from "./annotation";
import type { Role } from "../sharing/roles";
import type { Viewer } from "../sharing/access";

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A pinned point on the original image (AS-005). x/y are normalized 0..1. */
export interface PointRegion {
  kind: "point";
  x: number;
  y: number;
}

/**
 * A boxed region on the original image (AS-006). x/y is the top-left corner, w/h the
 * size — all normalized 0..1 and clamped so a drag that runs off the image still yields
 * an in-bounds box.
 */
export interface BoxRegion {
  kind: "box";
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ImageRegion = PointRegion | BoxRegion;

/** Pixel coordinates within a given viewport rect (denormalize target). */
export interface PixelPoint {
  x: number;
  y: number;
}

/**
 * Pin a point: a viewport click → a point region in normalized 0..1 coordinates relative
 * to the original image (AS-005). Reuses normalizePoint, which already clamps out-of-bounds.
 */
export function pointRegion(clientX: number, clientY: number, rect: Rect): PointRegion {
  const { x, y } = normalizePoint(clientX, clientY, rect);
  return { kind: "point", x, y };
}

/**
 * Box a region: two viewport corners of a drag → a box region in normalized 0..1
 * coordinates (AS-006). Both corners are normalized via normalizePoint, then x/y/w/h are
 * derived from the min corner and the absolute extent — so the drag direction (any of the
 * four diagonals) does not matter, and a zero-distance drag yields a zero-size box.
 */
export function boxRegion(
  start: { clientX: number; clientY: number },
  end: { clientX: number; clientY: number },
  rect: Rect,
): BoxRegion {
  const a = normalizePoint(start.clientX, start.clientY, rect);
  const b = normalizePoint(end.clientX, end.clientY, rect);

  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  // Corners are already clamped to 0..1, so |b-a| is at most 1 and x+w stays in-bounds.
  const w = clamp01(Math.abs(b.x - a.x));
  const h = clamp01(Math.abs(b.y - a.y));

  return { kind: "box", x, y, w, h };
}

/**
 * Map a stored normalized point back to on-screen pixels for a given viewport rect
 * (AS-007). This is the inverse of normalizePoint: round-tripping a stored point through
 * ANY rect reproduces the same point on that rect, which is exactly why the mark does not
 * drift when the image is zoomed (200%, 50%) or opened at a different screen size — the
 * stored 0..1 coordinates are the single source of truth; the rect is just the lens.
 */
export function denormalizePoint(point: { x: number; y: number }, rect: Rect): PixelPoint {
  return {
    x: rect.left + clamp01(point.x) * rect.width,
    y: rect.top + clamp01(point.y) * rect.height,
  };
}

/**
 * Build an image-region Anchor for storage in the annotation `anchor` jsonb. An image
 * region has no text, so the text-anchor fields are empty/zero and the region is carried
 * under `region`; type is "block" (a single positional mark on the doc, like a block
 * anchor — no range/segments). The jsonb stays portable (plain numbers + a kind tag).
 */
export function imageRegionAnchor(blockId: string, region: ImageRegion): Anchor {
  return {
    blockId,
    textSnippet: "",
    offset: 0,
    length: 0,
    region,
  };
}

export interface CreateImageRegionInput {
  docId: string;
  blockId: string;
  region: ImageRegion;
  viewer: Viewer;
  /** Server-resolved session role — the ONLY thing that authorizes the write (C-009). */
  sessionRole: Role;
}

/**
 * Create an image-region annotation via the S-001 createAnnotation path, so the SAME
 * server re-authorization (can(sessionRole,"comment")) gates it — an image-region write
 * is not a privileged side door around the text-annotation auth.
 */
export function createImageRegionAnnotation(
  input: CreateImageRegionInput,
  repo: AnnotationRepo,
): Promise<CreateAnnotationResult> {
  const { docId, blockId, region, viewer, sessionRole } = input;
  return createAnnotation(
    {
      docId,
      anchor: imageRegionAnchor(blockId, region),
      viewer,
      sessionRole,
      type: "block",
    },
    repo,
  );
}
