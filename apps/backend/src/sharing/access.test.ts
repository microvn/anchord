import { test, expect } from "bun:test";
import * as accessModule from "./access";
import type { Viewer, GeneralAccessLevel } from "./access";

// doc-access-two-axis S-004 / C-010: the standalone level-switching `canViewDoc` is RETIRED.
// There is now ONE access decision — `createResolveAccess` (resolve-access.ts), unit-tested in
// resolve-access.test.ts (owner + invite + the two axes + the capped anon admission). This file
// asserts the retirement holds — no parallel decision survives in access.ts — and that the shared
// `Viewer` shape + the derived `GeneralAccessLevel` re-export remain for the gates to speak.

test("C-010: canViewDoc is retired — access.ts exports no parallel access decision", () => {
  // The level-switching standalone decision must be GONE so it can never disagree with the
  // authoritative resolver. Only the Viewer shape + the derived-level re-export remain.
  expect((accessModule as Record<string, unknown>).canViewDoc).toBeUndefined();
  expect((accessModule as Record<string, unknown>).AccessDeps).toBeUndefined();
});

test("C-010: the shared Viewer shape (anon | user) is intact for every gate to consume", () => {
  // Both gate inputs still type-check — the consolidated resolver speaks this exact shape.
  const anon: Viewer = { kind: "anon" };
  const withCookie: Viewer = { kind: "anon", admissionCookie: "c" };
  const user: Viewer = { kind: "user", userId: "u1" };
  expect(anon.kind).toBe("anon");
  expect(withCookie.admissionCookie).toBe("c");
  expect(user.kind).toBe("user");
  // GeneralAccessLevel is still re-exported (the derived display summary, C-008).
  const level: GeneralAccessLevel = "anyone_in_workspace";
  expect(level).toBe("anyone_in_workspace");
});
