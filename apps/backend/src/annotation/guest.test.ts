import { test, expect } from "bun:test";
import {
  assignAnonName,
  createGuestComment,
  MAX_GUEST_NAME_LENGTH,
  type GuestCommentRepo,
  type NewGuestComment,
} from "./guest";
import { ANON_ANIMALS } from "../sharing/anon-identity";

// annotation-core S-007 — guest commenting. A logged-out viewer gets a random anon
// name (AS-016), comments with a name + optional email stored guest_name / author_id
// null (AS-017), and any HTML in body/guest_name is sanitized inert with the name
// length-capped (AS-019/C-008). Pure logic against a fake GuestCommentRepo (mirrors
// reply.test.ts).
//
// NOTE (sharing reversal 2026-06-20): there is NO guest-commenting toggle. An anon on an
// anyone_with_link + commenter+ doc is authorized to comment by the LINK ROLE alone (the
// route gates that); createGuestComment no longer takes/checks a `guestCommentingEnabled`
// flag, so there is no `guest_disabled` reason. This service only validates name + body.

function fakeRepo(): GuestCommentRepo & { inserted: NewGuestComment[] } {
  const inserted: NewGuestComment[] = [];
  let n = 0;
  return {
    inserted,
    async listByAnnotation() {
      return [];
    },
    async insertComment(input: NewGuestComment) {
      inserted.push(input);
      return { id: `c-${++n}` };
    },
  };
}

test("AS-016: a logged-out viewer is assigned a random name (reuse generateAnonName)", () => {
  // Deterministic picker → "Anonymous <first animal>".
  const name = assignAnonName(() => 0);
  expect(name).toBe(`Anonymous ${ANON_ANIMALS[0]}`);
  // Shape holds for any picked index — always "Anonymous <known animal>".
  for (let i = 0; i < ANON_ANIMALS.length; i++) {
    const n = assignAnonName(() => i);
    expect(n).toBe(`Anonymous ${ANON_ANIMALS[i]}`);
  }
});

test("AS-017: guest comment stored with guest_name 'Lan', author_id empty, email optional-and-stored — NO toggle required (link role is the grant)", async () => {
  const repo = fakeRepo();
  const res = await createGuestComment(
    {
      annotationId: "ann-1",
      guestName: "Lan",
      email: "lan@example.com",
      body: "looks good to me",
    },
    repo,
  );

  expect(res).toEqual({ created: true, id: "c-1" });
  expect(repo.inserted).toHaveLength(1);
  const row = repo.inserted[0];
  expect(row.guestName).toBe("Lan"); // AS-017: the entered name
  expect(row.authorId).toBeNull(); // AS-017: author_id empty (no account)
  expect(row.parentId).toBeNull(); // top-level comment on the annotation
  expect(row.guestEmail).toBe("lan@example.com"); // optional email stored when given
});

test("AS-017: the email is OPTIONAL — a guest comment with no email still stores (guestEmail absent)", async () => {
  const repo = fakeRepo();
  const res = await createGuestComment(
    { annotationId: "ann-1", guestName: "Lan", body: "no email here" },
    repo,
  );
  expect(res.created).toBe(true);
  expect(repo.inserted[0].guestName).toBe("Lan");
  expect(repo.inserted[0].guestEmail).toBeUndefined(); // not required, not stored
});

test("C-007: guest comments REQUIRE a name — empty / whitespace-only name is rejected, nothing persisted", async () => {
  const repo = fakeRepo();

  const empty = await createGuestComment(
    { annotationId: "ann-1", guestName: "", body: "anon body" },
    repo,
  );
  expect(empty).toEqual({ created: false, reason: "empty_name" });

  const ws = await createGuestComment(
    { annotationId: "ann-1", guestName: "   \t ", body: "anon body" },
    repo,
  );
  expect(ws).toEqual({ created: false, reason: "empty_name" });

  expect(repo.inserted).toHaveLength(0);
});

test("AS-017: NO guest-commenting toggle exists — a valid guest comment is created without any toggle precondition (the bug fix)", async () => {
  // Regression for the live bug: the guest comment used to be gated by a never-emitted toggle.
  // createGuestComment now accepts only { annotationId, guestName, email?, body } — a valid name
  // + body is created purely on its own merits (the route already authorized via the link role).
  const repo = fakeRepo();
  const res = await createGuestComment(
    { annotationId: "ann-1", guestName: "Sam", body: "I can comment as a guest now" },
    repo,
  );
  expect(res).toEqual({ created: true, id: "c-1" });
  expect(repo.inserted).toHaveLength(1);
  expect(repo.inserted[0].guestName).toBe("Sam");
  expect(repo.inserted[0].authorId).toBeNull(); // still a non-spoofable guest marker
});

test("AS-019 / C-008: HTML in the body renders inert — <img onerror> / <script> neutralized in the STORED value", async () => {
  const repo = fakeRepo();
  await createGuestComment(
    {
      annotationId: "ann-1",
      guestName: "Lan",
      body: `<img src=x onerror=alert(1)> and <script>alert(2)</script> done`,
    },
    repo,
  );

  const stored = repo.inserted[0].body;
  // Falsifiability: the executable handler and the script tag must be gone.
  expect(stored).not.toContain("onerror");
  expect(stored).not.toContain("alert(1)");
  expect(stored.toLowerCase()).not.toContain("<script");
  expect(stored).not.toContain("alert(2)");
  // Plain words around the payload survive — sanitize stripped tags, not text.
  expect(stored).toContain("and");
  expect(stored).toContain("done");
});

test("AS-019 / C-008: HTML in the guest_name renders inert — tags stripped from the STORED name", async () => {
  const repo = fakeRepo();
  await createGuestComment(
    {
      annotationId: "ann-1",
      guestName: `<img src=x onerror=alert(1)>Lan<script>x</script>`,
      body: "hi",
    },
    repo,
  );

  const name = repo.inserted[0].guestName!;
  expect(name).not.toContain("onerror");
  expect(name.toLowerCase()).not.toContain("<script");
  expect(name).not.toContain("<img");
  expect(name).toContain("Lan"); // the real name text is kept
});

test("C-008: a name that is ONLY HTML/script (sanitizes to empty) is treated as missing → empty_name", async () => {
  const repo = fakeRepo();
  const res = await createGuestComment(
    { annotationId: "ann-1", guestName: "<script>alert(1)</script>", body: "hi" },
    repo,
  );
  expect(res).toEqual({ created: false, reason: "empty_name" });
  expect(repo.inserted).toHaveLength(0);
});

test("AS-019 / C-008: an over-long guest_name is truncated to MAX_GUEST_NAME_LENGTH", async () => {
  const repo = fakeRepo();
  const longName = "x".repeat(MAX_GUEST_NAME_LENGTH + 200);
  await createGuestComment(
    { annotationId: "ann-1", guestName: longName, body: "hi" },
    repo,
  );
  const stored = repo.inserted[0].guestName!;
  expect(stored.length).toBe(MAX_GUEST_NAME_LENGTH);
  expect(stored).toBe("x".repeat(MAX_GUEST_NAME_LENGTH));
});

test("C-008: control characters are stripped from the guest_name (charset limit)", async () => {
  const repo = fakeRepo();
  await createGuestComment(
    { annotationId: "ann-1", guestName: "La\x00n\x07\nh", body: "hi" },
    repo,
  );
  const stored = repo.inserted[0].guestName!;
  expect(stored).toBe("Lanh"); // NUL, BEL, newline removed
  // eslint-disable-next-line no-control-regex
  expect(/[\x00-\x1F\x7F]/.test(stored)).toBe(false);
});

test("AS-017: empty / whitespace-only body is rejected (empty_body), nothing persisted", async () => {
  const repo = fakeRepo();
  const res = await createGuestComment(
    { annotationId: "ann-1", guestName: "Lan", body: "   \n " },
    repo,
  );
  expect(res).toEqual({ created: false, reason: "empty_body" });
  expect(repo.inserted).toHaveLength(0);
});
