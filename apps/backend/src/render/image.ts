// Image render logic (story S-004). The zoom/pan UI and the corrupt-image placeholder
// are visual (browser/[→MANUAL]); the testable logic backing them lives here:
// normalized pin coordinates (also used by annotation-core image-region), SVG-vs-raster
// render routing, and corrupt-image detection.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Map a viewport click to coordinates normalized 0..1 against the original image, so a
 * pin/box stays put across zoom and screen-size changes (AS-011). Out-of-bounds clamps.
 */
export function normalizePoint(clientX: number, clientY: number, rect: Rect): { x: number; y: number } {
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

/**
 * How to render an image artifact. SVG can carry script, so it goes through the
 * sandbox content route (isolated, like HTML); raster formats render as a plain <img>
 * which executes nothing (AS-013).
 */
export function imageRenderMode(mime: string): "sandbox" | "img" {
  return mime === "image/svg+xml" ? "sandbox" : "img";
}

// Magic-byte signatures for the raster formats we accept.
const SIGNATURES: Array<[number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], "png"],
  [[0xff, 0xd8, 0xff], "jpeg"],
  [[0x47, 0x49, 0x46, 0x38], "gif"],
  [[0x52, 0x49, 0x46, 0x46], "webp"], // RIFF (webp container)
];

/** True if the bytes start with a known image signature; false (→ placeholder) otherwise (AS-012). */
export function isRenderableImage(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 4) return false;
  for (const [sig] of SIGNATURES) {
    if (sig.every((b, i) => bytes[i] === b)) return true;
  }
  // SVG: text starting with "<svg" or an XML prolog containing <svg
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 256)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return true;
  return false;
}
