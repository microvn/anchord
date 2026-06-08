import { test, expect } from "bun:test";
import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAsset, readAsset, AssetStorageError } from "./assets";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "anchord-assets-"));
}

test("AS-005 / C-003: saveAsset writes image bytes to the assets volume and readAsset returns them (content text stays in Postgres)", async () => {
  const dir = freshDir();
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  const path = await saveAsset(dir, "doc1/v1.png", bytes);
  expect(path.startsWith(dir)).toBe(true);
  const back = await readAsset(dir, "doc1/v1.png");
  expect(Array.from(back)).toEqual(Array.from(bytes));
  rmSync(dir, { recursive: true, force: true });
});

test("AS-006 / C-005: saveAsset throws a clear AssetStorageError when the dir is not writable (no crash)", async () => {
  const dir = freshDir();
  chmodSync(dir, 0o500); // read+execute, no write
  let err: unknown;
  try {
    await saveAsset(dir, "doc1/v1.png", new Uint8Array([1, 2, 3]));
  } catch (e) {
    err = e;
  }
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
  expect(err).toBeInstanceOf(AssetStorageError);
  expect((err as AssetStorageError).message).toContain("write");
});

test("AS-006: saveAsset rejects a path that escapes the assets dir (no traversal)", async () => {
  const dir = freshDir();
  let err: unknown;
  try {
    await saveAsset(dir, "../escape.png", new Uint8Array([1]));
  } catch (e) {
    err = e;
  }
  rmSync(dir, { recursive: true, force: true });
  expect(err).toBeInstanceOf(AssetStorageError);
});
