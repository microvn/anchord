import { test, expect } from "bun:test";
import { normalizePoint, imageRenderMode, isRenderableImage } from "./image";

test("AS-011: normalizePoint maps a click to 0..1 coords on the original image", () => {
  const rect = { left: 100, top: 50, width: 800, height: 600 };
  expect(normalizePoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
  expect(normalizePoint(500, 350, rect)).toEqual({ x: 0.5, y: 0.5 });
  expect(normalizePoint(900, 650, rect)).toEqual({ x: 1, y: 1 });
});

test("AS-011: normalizePoint clamps points outside the image to the 0..1 range", () => {
  const rect = { left: 0, top: 0, width: 200, height: 200 };
  expect(normalizePoint(-50, 300, rect)).toEqual({ x: 0, y: 1 });
});

test("AS-013: SVG renders via the sandbox route, raster via <img>", () => {
  expect(imageRenderMode("image/svg+xml")).toBe("sandbox");
  expect(imageRenderMode("image/png")).toBe("img");
  expect(imageRenderMode("image/jpeg")).toBe("img");
  expect(imageRenderMode("image/webp")).toBe("img");
});

test("AS-012: a valid PNG is renderable, a corrupt/non-image blob is not (→ placeholder)", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(isRenderableImage(png)).toBe(true);
  const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  expect(isRenderableImage(garbage)).toBe(false);
  expect(isRenderableImage(new Uint8Array([]))).toBe(false);
});
