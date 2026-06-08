import { test, expect } from "bun:test";
import {
  generateAnonName,
  createAnonIdentity,
  renameAnon,
  InvalidAnonName,
  ANON_ANIMALS,
  type AnimalPicker,
} from "./anon-identity";

// Sharing S-002: the anonymous session identity. UNIT tests of the random-name
// generator + rename logic. Deterministic via an injected picker (Math.random is not
// available in every runtime context). annotation-core reuses this generator (its
// AS-016), so it must stay importable.

const pick = (i: number): AnimalPicker => () => i;

test("AS-004: an anonymous viewer is assigned a random 'Anonymous <Animal>' name", () => {
  // Deterministic picker → exact name; proves the format and that it draws from the list.
  expect(generateAnonName(pick(0))).toBe(`Anonymous ${ANON_ANIMALS[0]}`);
  expect(generateAnonName(pick(2))).toBe(`Anonymous ${ANON_ANIMALS[2]}`);

  // The identity created for a session carries that random display name.
  const id = createAnonIdentity("sess-1", pick(1));
  expect(id.sessionId).toBe("sess-1");
  expect(id.displayName).toBe(`Anonymous ${ANON_ANIMALS[1]}`);

  // Default picker (Math.random) still yields a well-formed name in range.
  expect(generateAnonName()).toMatch(/^Anonymous \w+$/);

  // Boundary: an out-of-range / non-finite picker index is clamped, never throws or
  // produces "Anonymous undefined".
  expect(generateAnonName(pick(999))).toBe(`Anonymous ${ANON_ANIMALS[ANON_ANIMALS.length - 1]}`);
  expect(generateAnonName(pick(-5))).toBe(`Anonymous ${ANON_ANIMALS[0]}`);
  expect(generateAnonName(() => NaN)).toBe(`Anonymous ${ANON_ANIMALS[0]}`);
});

test("AS-005: the anonymous identity is renameable for the session (name attaches to comments)", () => {
  const id = createAnonIdentity("sess-1", pick(0));
  const renamed = renameAnon(id, "Lan");
  expect(renamed.displayName).toBe("Lan");
  // Same session — rename maps back to the same anon (so it attaches to their comments).
  expect(renamed.sessionId).toBe("sess-1");
  // Immutable update — the original identity is untouched.
  expect(id.displayName).toBe(`Anonymous ${ANON_ANIMALS[0]}`);

  // Whitespace is trimmed (the trimmed name is what attaches to a comment later).
  expect(renameAnon(id, "  Lan  ").displayName).toBe("Lan");

  // Special characters / unicode are stored as-is here (annotation-core C-008 sanitizes
  // before render — not this module's job).
  expect(renameAnon(id, "Lan 🦊 <b>").displayName).toBe("Lan 🦊 <b>");

  // Empty / whitespace-only names are rejected.
  expect(() => renameAnon(id, "")).toThrow(InvalidAnonName);
  expect(() => renameAnon(id, "   ")).toThrow(InvalidAnonName);
});

test("C-004: anyone-with-link allows anon view with a random, renameable name", () => {
  // End-to-end of the identity lifecycle the constraint promises: random on creation,
  // then renameable for the session.
  const id = createAnonIdentity("sess-42", pick(3));
  expect(id.displayName).toBe(`Anonymous ${ANON_ANIMALS[3]}`); // random (assigned)
  const renamed = renameAnon(id, "Reviewer Lan");
  expect(renamed.displayName).toBe("Reviewer Lan"); // renameable
  expect(renamed.sessionId).toBe("sess-42");
});
