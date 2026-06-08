import { z } from "zod";
import { ValidationError } from "./errors";

/**
 * S-006: the shared pagination contract for anchord's list endpoints.
 *
 * Every `/api/*` list route accepts the same paging params (`page`, `limit`,
 * `sort`) and returns the same `{ items, pagination }` block, so a client can
 * render pagers identically everywhere (C-008).
 *
 * Two boundary rules, both per spec (AS-015), and they are DELIBERATELY
 * asymmetric:
 *   - `limit` over the cap is **clamped** to the max — lenient, NOT an error.
 *     Asking for too many rows is a soft request; we just give the most allowed.
 *   - `page` below 1 is **rejected** — a `ValidationError` (→400,
 *     VALIDATION_ERROR via the S-001 envelope). Pages are 1-based; page 0 / -1
 *     is a client bug, not a soft request, so we surface it rather than silently
 *     coercing it to 1.
 *
 * Composes with `apiEnvelope` (S-001): the thrown `ValidationError` is wrapped by
 * the envelope's onError into the 400 error envelope, exactly like S-005's
 * `validateBody`. We reuse `ValidationError` rather than minting a new error path.
 */

/** Parsed, bounded paging params handed to a list service. */
export type PaginationParams = {
  /** 1-based page index (≥ 1, guaranteed by the schema). */
  page: number;
  /** Rows per page (≥ 1, clamped to the configured max). */
  limit: number;
  /** Optional sort key, passed through verbatim for the service to interpret. */
  sort?: string;
};

/** The pagination metadata block returned alongside `items`. */
export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
};

/** The full list-endpoint payload: drops straight into the envelope's `data`. */
export type Paginated<T> = {
  items: T[];
  pagination: PaginationMeta;
};

/**
 * Build a Zod schema that parses raw query strings into {@link PaginationParams}.
 *
 * - `page`: coerced to a number, must be an integer ≥ 1. A page below 1 (or a
 *   non-integer / non-numeric page) is REJECTED — the `.transform` throws a
 *   `ValidationError` so the envelope turns it into a 400 VALIDATION_ERROR
 *   (AS-015). We throw inside the schema (rather than rely on `.parse` throwing a
 *   ZodError) so the error code/field match the rest of the API uniformly.
 * - `limit`: coerced to a number, must be an integer ≥ 1, then CLAMPED to
 *   `maxLimit` — a limit over the cap is silently lowered, never an error
 *   (AS-015, lenient). Missing → `defaultLimit`.
 * - `sort`: optional string, passed through untouched.
 *
 * Defaults: `defaultLimit = 20`, `maxLimit = 100`.
 */
export function paginationQuery(
  opts: { maxLimit?: number; defaultLimit?: number } = {},
): z.ZodType<PaginationParams> {
  const maxLimit = opts.maxLimit ?? 100;
  const defaultLimit = opts.defaultLimit ?? 20;

  // Coerce a raw query value to a number ourselves (rather than z.coerce.number,
  // which raises a ZodError for NaN BEFORE our transform runs). Returning NaN
  // here lets the transform reject every bad input as a uniform ValidationError.
  const toNum = (v: unknown): number =>
    typeof v === "number" ? v : Number(v as any);

  const pageSchema = z.unknown().optional().transform((raw) => {
    // page must be a 1-based integer; anything else (below 1, non-integer,
    // non-numeric) is a client bug → reject as 400 VALIDATION_ERROR.
    const n = raw === undefined || raw === null || raw === "" ? 1 : toNum(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new ValidationError("page must be an integer >= 1", { field: "page" });
    }
    return n;
  });

  const limitSchema = z.unknown().optional().transform((raw) => {
    const n = raw === undefined || raw === null || raw === "" ? defaultLimit : toNum(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new ValidationError("limit must be an integer >= 1", { field: "limit" });
    }
    // Over the cap → clamp (lenient), do NOT reject.
    return Math.min(n, maxLimit);
  });

  return z
    .object({
      page: pageSchema,
      limit: limitSchema,
      sort: z.string().optional(),
    })
    .transform((parsed): PaginationParams => ({
      page: parsed.page,
      limit: parsed.limit,
      ...(parsed.sort !== undefined ? { sort: parsed.sort } : {}),
    })) as unknown as z.ZodType<PaginationParams>;
}

/**
 * Compute the pagination metadata from `page`, `limit`, and the `total` row
 * count. Pure — no I/O.
 *
 * Empty result (`total === 0`): `totalPages` is 0 (an honest "no pages"), and
 * both `hasNext`/`hasPrevious` are false. For a non-empty result `totalPages`
 * is `ceil(total / limit)`. `hasNext` = page < totalPages, `hasPrevious` =
 * page > 1.
 */
export function buildPagination(args: {
  page: number;
  limit: number;
  total: number;
}): PaginationMeta {
  const { page, limit, total } = args;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

/**
 * Wrap a page of `items` with its pagination metadata into the uniform
 * {@link Paginated} shape — return this from a list handler and the S-001
 * envelope nests it under `data` (AS-014).
 */
export function paginate<T>(
  items: T[],
  args: { page: number; limit: number; total: number },
): Paginated<T> {
  return { items, pagination: buildPagination(args) };
}
