// HTTP route mount for search (workspace-project S-005).
//
// INTEGRATION GLUE over the unit-tested search service (src/search/search.ts) + the
// FTS repo (src/search/search-repo.ts — the portability boundary). Same api-core
// composition as the other route clusters: apiEnvelope → requireSession. Identity is
// the SERVER session actor (anti-forgery) — the searcher is ctx.actor.userId, NEVER a
// query/body field. Access filtering is C-003's ONE rule for browse AND search.
//
// Contract:
//   GET /api/search?q=<text>&projectId=<uuid?>  → 200 { results: [...] }
//     - q required, non-empty after trim → else 400 VALIDATION_ERROR.
//     - projectId optional (AS-010 project scope); omitted → whole workspace.
//   Auth: session (any member). Out-of-access docs are ABSENT (existence-hiding, C-003).

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { validateBody } from "../http/validate";
import { search, SearchRejected, type SearchDeps } from "../search/search";
import { createSearchRepo, type SearchRepo } from "../search/search-repo";
import { ValidationError } from "../http/errors";
import type { DB } from "../db/client";

/** Query schema: q is required + non-empty; projectId optional uuid. Unknown keys stripped. */
export const searchQuerySchema = z.object({
  q: z.string().min(1, "search query is required"),
  projectId: z.string().uuid().optional(),
});

export interface SearchRoutesDeps {
  db?: DB;
  /** Pre-built FTS repo (tests). Wins over `db`. */
  repo?: SearchRepo;
  resolveSession: SessionResolver;
}

export function searchRoutes(deps: SearchRoutesDeps) {
  const repo: SearchRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("searchRoutes requires either `repo` or `db`");
      return createSearchRepo(deps.db);
    })();

  // Production trusts the repo's SQL access filter (out-of-access rows never leave
  // the DB). The defense-in-depth re-check (deps.access) is a TEST seam — the route
  // doesn't wire it, so production has no extra round-trip.
  const serviceDeps: SearchDeps = { repo };

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .get("/api/search", async ({ query, actor }) => {
      // Validate the QUERY object (q + optional projectId). A blank q → 400 here OR
      // via the service's parseQuery; both surface as VALIDATION_ERROR.
      const { q, projectId } = validateBody(searchQuerySchema, query);
      try {
        const results = await search(
          { q, userId: actor.userId, projectId },
          serviceDeps,
        );
        return { results };
      } catch (err) {
        if (err instanceof SearchRejected) throw new ValidationError(err.message);
        throw err;
      }
    });
}
