import { test, expect } from "bun:test";
import { Elysia } from "elysia";
import { apiEnvelope } from "./envelope";
import { ValidationError } from "./errors";
import {
  paginationQuery,
  buildPagination,
  paginate,
} from "./pagination";

/**
 * S-006: list endpoints share a uniform pagination contract.
 *
 * We test two ways, per the design:
 *   - the pure helpers (`buildPagination` / `paginate` / `paginationQuery`)
 *     directly — fast, exact;
 *   - end-to-end through a throwaway /api list route built from `apiEnvelope` +
 *     the pagination query parse, driven by `app.handle()` — so the code→wire
 *     mapping (clamp vs 400) is proven through the real envelope, not just the
 *     helper shape.
 */

// A throwaway list route: parse the query with paginationQuery, then return the
// paginated block as raw data (the envelope nests it under `data`).
function buildApp() {
  const schema = paginationQuery({ maxLimit: 100, defaultLimit: 20 });
  return new Elysia().group("/api", (api) =>
    apiEnvelope(api).get("/items", ({ query }) => {
      const params = schema.parse(query);
      // 25 rows total; slice the requested page so items length is realistic.
      const total = 25;
      const all = Array.from({ length: total }, (_, i) => i + 1);
      const start = (params.page - 1) * params.limit;
      const items = all.slice(start, start + params.limit);
      return paginate(items, { page: params.page, limit: params.limit, total });
    }),
  );
}

function get(app: ReturnType<typeof buildApp>, qs: string) {
  return app.handle(new Request(`http://localhost/api/items${qs}`));
}

// ── AS-014: list endpoint returns {items, pagination:{...}} with correct values

test("AS-014: page 1 limit 10 over 25 rows → 10 items, total 25, totalPages 3, hasNext true, hasPrevious false", async () => {
  const res = await get(buildApp(), "?page=1&limit=10");
  expect(res.status).toBe(200);
  const json = (await res.json()) as any;
  expect(json.success).toBe(true);
  expect(json.data.items).toHaveLength(10);
  expect(json.data.pagination).toEqual({
    page: 1,
    limit: 10,
    total: 25,
    totalPages: 3,
    hasNext: true,
    hasPrevious: false,
  });
});

test("AS-014: middle page (page 3, limit 10) → hasNext false, hasPrevious true (boundary depth)", async () => {
  const res = await get(buildApp(), "?page=3&limit=10");
  const json = (await res.json()) as any;
  // 25 rows, page 3, limit 10 → last page has 5 items.
  expect(json.data.items).toHaveLength(5);
  expect(json.data.pagination).toEqual({
    page: 3,
    limit: 10,
    total: 25,
    totalPages: 3,
    hasNext: false,
    hasPrevious: true,
  });
});

test("AS-014: buildPagination computes the metadata block directly (pure helper)", () => {
  expect(buildPagination({ page: 1, limit: 10, total: 25 })).toEqual({
    page: 1,
    limit: 10,
    total: 25,
    totalPages: 3,
    hasNext: true,
    hasPrevious: false,
  });
});

test("AS-014: paginate wraps items + pagination into the {items, pagination} block", () => {
  const out = paginate([1, 2, 3], { page: 1, limit: 3, total: 9 });
  expect(out.items).toEqual([1, 2, 3]);
  expect(out.pagination.totalPages).toBe(3);
  expect(out.pagination.hasNext).toBe(true);
  expect(out.pagination.hasPrevious).toBe(false);
});

test("AS-014: empty result (total 0) → totalPages 0, hasNext/hasPrevious false (edge: empty)", () => {
  expect(buildPagination({ page: 1, limit: 10, total: 0 })).toEqual({
    page: 1,
    limit: 10,
    total: 0,
    totalPages: 0,
    hasNext: false,
    hasPrevious: false,
  });
});

// ── AS-015: limit over max clamped; page < 1 → 400 VALIDATION_ERROR ──────────

test("AS-015: limit 1000 (max 100) is clamped to 100, not rejected (end-to-end)", async () => {
  const res = await get(buildApp(), "?page=1&limit=1000");
  expect(res.status).toBe(200);
  const json = (await res.json()) as any;
  expect(json.data.pagination.limit).toBe(100);
});

test("AS-015: paginationQuery clamps limit over max to the cap (pure helper)", () => {
  const schema = paginationQuery({ maxLimit: 100, defaultLimit: 20 });
  expect(schema.parse({ page: "1", limit: "1000" }).limit).toBe(100);
});

test("AS-015: page 0 → 400 VALIDATION_ERROR through the envelope (end-to-end)", async () => {
  const res = await get(buildApp(), "?page=0&limit=10");
  expect(res.status).toBe(400);
  const json = (await res.json()) as any;
  expect(json.success).toBe(false);
  expect(json.error.code).toBe("VALIDATION_ERROR");
  expect(json.error.field).toBe("page");
});

test("AS-015: paginationQuery throws ValidationError for page < 1 (pure helper, edge: boundary)", () => {
  const schema = paginationQuery();
  let thrown: unknown;
  try {
    schema.parse({ page: "0" });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  const err = thrown as ValidationError;
  expect(err.code).toBe("VALIDATION_ERROR");
  expect(err.status).toBe(400);
  expect(err.field).toBe("page");
});

test("AS-015: non-integer / invalid page is rejected as VALIDATION_ERROR (edge: invalid type)", () => {
  const schema = paginationQuery();
  expect(() => schema.parse({ page: "1.5" })).toThrow(ValidationError);
  expect(() => schema.parse({ page: "abc" })).toThrow(ValidationError);
  expect(() => schema.parse({ page: "-3" })).toThrow(ValidationError);
});

// ── C-008: shared contract — page/limit/sort accepted; defaults; sort passthrough

test("C-008: missing page/limit fall back to defaults (page 1, defaultLimit)", () => {
  const schema = paginationQuery({ maxLimit: 100, defaultLimit: 20 });
  const out = schema.parse({});
  expect(out.page).toBe(1);
  expect(out.limit).toBe(20);
});

test("C-008: sort is accepted and passed through verbatim", () => {
  const schema = paginationQuery();
  const out = schema.parse({ page: "2", limit: "5", sort: "createdAt:desc" });
  expect(out).toEqual({ page: 2, limit: 5, sort: "createdAt:desc" });
});

test("C-008: limit below 1 is rejected as VALIDATION_ERROR (contract: limit must be >= 1)", () => {
  const schema = paginationQuery();
  expect(() => schema.parse({ page: "1", limit: "0" })).toThrow(ValidationError);
});
