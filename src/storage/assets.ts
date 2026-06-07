import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** Thrown on any asset storage failure, with a clear, operator-readable message. */
export class AssetStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetStorageError";
  }
}

/** Resolve `key` under `baseDir`, refusing any path that escapes the base (no traversal). */
function resolveSafe(baseDir: string, key: string): string {
  const base = resolve(baseDir);
  const full = resolve(base, key);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new AssetStorageError(`asset key escapes assets dir: ${key}`);
  }
  return full;
}

/**
 * Store image bytes on the assets volume (self-host C-003). Content text stays in
 * Postgres; only binary assets live here. Throws AssetStorageError (clear message,
 * no crash — C-005) when the dir is not writable or the key is unsafe.
 */
export async function saveAsset(baseDir: string, key: string, bytes: Uint8Array): Promise<string> {
  const full = resolveSafe(baseDir, key);
  try {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return full;
  } catch (e) {
    throw new AssetStorageError(
      `failed to write asset ${key} to ${baseDir}: ${(e as Error).message}`,
    );
  }
}

/** Read image bytes back from the assets volume. */
export async function readAsset(baseDir: string, key: string): Promise<Uint8Array> {
  const full = resolveSafe(baseDir, key);
  try {
    return new Uint8Array(await readFile(full));
  } catch (e) {
    throw new AssetStorageError(
      `failed to read asset ${key} from ${baseDir}: ${(e as Error).message}`,
    );
  }
}

export { join as joinAssetKey };
