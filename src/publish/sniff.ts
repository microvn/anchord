// Content sniffing + size caps for the publish flow (story S-001).
// C-003: cap HTML/MD at 5MB, images at 25MB; over → reject before storing.
// C-005: the content kind is decided by sniffing the bytes, not by trusting
// the file extension. A declared .html that is actually binary is rejected.

export type DocKind = "html" | "markdown" | "image";

/** Thrown when an artifact fails a publish-time guard (size cap, type mismatch, empty). */
export class PublishRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRejected";
  }
}

// C-003 caps, in bytes.
export const MAX_TEXT_BYTES = 5 * 1024 * 1024; // HTML / Markdown
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // images

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * Enforce the size cap for a kind (C-003 / AS-004). Throws PublishRejected with the
 * ACTUAL size and the cap in the message so the author sees why it was refused.
 * Returns nothing on success.
 */
export function validateSize(kind: DocKind, byteLength: number): void {
  const cap = kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (byteLength > cap) {
    throw new PublishRejected(
      `${kind} artifact is ${humanSize(byteLength)}, over the ${humanSize(cap)} limit — not published`,
    );
  }
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const GIF = [0x47, 0x49, 0x46]; // "GIF"

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

function looksLikeImage(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG) || startsWith(bytes, JPEG) || startsWith(bytes, GIF);
}

// A byte stream is "text" if it has no NUL and is decodable as UTF-8. Binary
// payloads (image/exe) carry NUL bytes or invalid UTF-8 sequences early on.
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (const b of sample) if (b === 0x00) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function extOf(filename: string | undefined): string {
  if (!filename) return "";
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function declaredKind(ext: string): DocKind | undefined {
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  return undefined;
}

/**
 * Decide the real kind of an artifact from its BYTES (C-005), then reconcile with the
 * extension. If the content clearly contradicts the declared extension (e.g. report.html
 * whose bytes are binary), reject (AS-005). When there is no extension, fall back to
 * pure content sniffing. `declaredKind` lets a paste flow assert markdown/html directly.
 */
export function sniffKind(
  filename: string | undefined,
  bytes: Uint8Array,
  declared?: DocKind,
): DocKind {
  if (bytes.length === 0) {
    throw new PublishRejected("artifact is empty — nothing to publish");
  }

  const ext = extOf(filename);
  const byExt = declared ?? declaredKind(ext);

  if (looksLikeImage(bytes)) {
    // Bytes are an image. If the author declared text, that's a mismatch.
    if (byExt === "html" || byExt === "markdown") {
      throw new PublishRejected(
        `content sniffed as image but declared ${byExt} (${filename ?? "paste"}) — not published`,
      );
    }
    return "image";
  }

  // Bytes are not an image. If they aren't valid text either, they're binary of an
  // unknown kind — reject regardless of what the extension claims (C-005).
  if (!looksLikeText(bytes)) {
    throw new PublishRejected(
      `content of ${filename ?? "paste"} is binary and does not match a supported text type — not published`,
    );
  }

  // Text content. If the author declared an image extension, that's a mismatch.
  if (byExt === "image") {
    throw new PublishRejected(
      `content sniffed as text but declared image (${filename ?? "paste"}) — not published`,
    );
  }

  // Distinguish html from markdown by content markers; honor an explicit declaration.
  if (byExt === "html" || byExt === "markdown") return byExt;

  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 2048)).toLowerCase();
  if (head.includes("<!doctype html") || head.includes("<html") || head.includes("<title")) {
    return "html";
  }
  return "markdown";
}
