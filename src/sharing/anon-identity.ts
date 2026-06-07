// Anonymous session identity (sharing S-002): someone who opens an anyone-with-link
// doc without an account gets a random display name ("Anonymous Cat") for the session,
// and can rename themselves. This same name later attaches to a guest comment.
//
// AS-004: assign a random name on an anonymous view.
// AS-005: rename the anonymous identity for the session (and it carries to comments).
// C-004:  anyone-with-link allows anon view with a random, renameable name.
//
// NOTE: annotation-core (its AS-016) ALSO references a random anon name — this module
// OWNS the generator; annotation-core reuses it. Keep it importable. We only store/trim
// the name here; sanitization of a guest name before render is annotation-core's C-008.

/** Fixed animal list for "Anonymous <Animal>" names. Stable ordering for the picker. */
export const ANON_ANIMALS: readonly string[] = [
  "Cat",
  "Otter",
  "Fox",
  "Owl",
  "Panda",
  "Heron",
  "Lynx",
  "Wren",
  "Seal",
  "Hare",
  "Crane",
  "Moth",
];

/**
 * Picks an index into ANON_ANIMALS. Injectable so tests are deterministic — Math.random
 * is not available in every runtime context this runs in. Receives the list length;
 * must return an integer in [0, length). Defaults to Math.random when not supplied.
 */
export type AnimalPicker = (length: number) => number;

const defaultPicker: AnimalPicker = (length) => Math.floor(Math.random() * length);

/**
 * Generate a random anonymous display name, e.g. "Anonymous Cat" (AS-004).
 * The picker is clamped into range so an out-of-bounds index can never throw or
 * produce "Anonymous undefined".
 */
export function generateAnonName(picker: AnimalPicker = defaultPicker): string {
  const raw = picker(ANON_ANIMALS.length);
  const idx = clampIndex(raw, ANON_ANIMALS.length);
  return `Anonymous ${ANON_ANIMALS[idx]}`;
}

function clampIndex(raw: number, length: number): number {
  if (!Number.isFinite(raw)) return 0;
  const i = Math.floor(raw);
  if (i < 0) return 0;
  if (i >= length) return length - 1;
  return i;
}

/** A per-session anonymous identity. `displayName` is what gets shown / attached to comments. */
export interface AnonIdentity {
  /** Stable id for the session (so renames map back to the same anon). */
  readonly sessionId: string;
  /** The currently displayed name — starts random, updated by renameAnon. */
  readonly displayName: string;
}

/** Create a fresh anonymous identity with a random display name (AS-004). */
export function createAnonIdentity(sessionId: string, picker?: AnimalPicker): AnonIdentity {
  return { sessionId, displayName: generateAnonName(picker) };
}

/** Thrown when a rename is rejected (AS-005 validates a non-empty name). */
export class InvalidAnonName extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnonName";
  }
}

/**
 * Rename the anonymous identity for the session (AS-005). Trims surrounding whitespace
 * (the trimmed name is what attaches to comments later). An empty / whitespace-only name
 * is rejected — annotation-core C-008 sanitizes content separately, so we only enforce
 * non-empty + trim here. Returns a NEW identity (immutable update); the sessionId is kept.
 */
export function renameAnon(identity: AnonIdentity, newName: string): AnonIdentity {
  const trimmed = newName.trim();
  if (trimmed.length === 0) {
    throw new InvalidAnonName("Display name cannot be empty");
  }
  return { sessionId: identity.sessionId, displayName: trimmed };
}
