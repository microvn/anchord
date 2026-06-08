// HTTP route mount for first-run setup (workspace-project S-001).
//
// First-run trigger: POST /api/setup, which REQUIRES a signed-in session (the
// installer signs up via better-auth first, then claims the instance). The setup
// insert IS the admin claim, which keeps "first user = admin" race-safe (C-001):
// only when zero workspaces exist does the claim succeed; a second call once a
// workspace exists → 409 CONFLICT (idempotent — the instance is already set up, no
// second workspace, no second admin).
//
// Anti-forgery: the admin is the SERVER-resolved session actor (ctx.actor.userId
// from requireSession), NEVER the request body. The body carries only the
// workspace name/branding/providers; a body that tries to set role:"admin" for
// someone else is ignored (the schema strips it, and the service uses actor.userId).
//
// Contract:
//   POST /api/setup — auth: session. Request: { name, settings: { providers, ... } }
//   Success: 201 { workspaceId, slug, name }.
//   Errors:  400 VALIDATION_ERROR (bad name/settings), 409 CONFLICT (already set up).

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { withValidation } from "../http/validate";
import { ValidationError, ConflictError } from "../http/errors";
import {
  createWorkspaceWithAdmin,
  SetupRejected,
  type WorkspaceRepo,
} from "../workspace/setup";
import { createWorkspaceRepo } from "../workspace/repo";
import type { DB } from "../db/client";

/**
 * First-run body. `name` is the workspace name; `settings` carries the enabled auth
 * providers (AS-001: GitHub+Google), an optional default-access level, and optional
 * branding. There is NO admin/role/userId field by design — identity is server-only
 * (anti-forgery); Zod strips any unknown key (e.g. a forged `role:"admin"`), and the
 * service derives the admin from the session actor.
 */
export const setupBodySchema = z.object({
  name: z.string().min(1, "workspace name is required"),
  settings: z.object({
    providers: z.object({
      github: z.boolean().default(false),
      google: z.boolean().default(false),
    }),
    defaultAccess: z
      .enum(["restricted", "anyone_in_workspace", "anyone_with_link"])
      .optional(),
    branding: z
      .object({ logoUrl: z.string().optional(), primaryColor: z.string().optional() })
      .optional(),
  }),
});

export type SetupBody = z.infer<typeof setupBodySchema>;

export interface SetupRoutesDeps {
  /** Drizzle handle — used to build the concrete WorkspaceRepo. */
  db?: DB;
  /** Pre-built repo (injectable for tests that want no DB). Wins over `db`. */
  repo?: WorkspaceRepo;
  /** Resolves the better-auth session → actor; gates the route (401 if none). */
  resolveSession: SessionResolver;
}

/**
 * Map a SetupRejected from the service onto the right HTTP DomainError.
 *  - already_set_up → 409 CONFLICT (idempotent refusal of a second first-run).
 *  - invalid_name   → 400 VALIDATION_ERROR (defense in depth; the schema also catches it).
 */
function mapSetupRejected(err: SetupRejected): ConflictError | ValidationError {
  if (err.code === "already_set_up") {
    return new ConflictError("Instance is already set up");
  }
  return new ValidationError(err.message);
}

/**
 * Elysia plugin factory for the first-run `/api/setup` route. Self-enveloped +
 * session-gated, mounted outside the /api/auth/* better-auth catch-all (the same
 * apiEnvelope → requireSession → withValidation composition as docsRoutes).
 */
export function setupRoutes(deps: SetupRoutesDeps) {
  const repo: WorkspaceRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("setupRoutes requires either `repo` or `db`");
      return createWorkspaceRepo(deps.db);
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    .use(withValidation(setupBodySchema))
    .post("/api/setup", async ({ validBody, actor, set }) => {
      const { name, settings } = validBody as SetupBody;
      try {
        const result = await createWorkspaceWithAdmin(
          {
            name,
            settings: {
              providers: settings.providers,
              defaultAccess: settings.defaultAccess,
              branding: settings.branding,
            },
            // C-001 / anti-forgery: admin = the SERVER session actor, never the body.
            adminUserId: actor.userId,
          },
          { repo },
        );
        set.status = 201;
        return { workspaceId: result.workspaceId, slug: result.slug, name: result.name };
      } catch (err) {
        if (err instanceof SetupRejected) throw mapSetupRejected(err);
        throw err; // unexpected → envelope generalizes to 500 (no leak)
      }
    });
}
