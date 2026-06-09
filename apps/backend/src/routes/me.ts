// HTTP route mount for the bootstrap surface (workspaces S-003). Stays at the TOP level
// (/api/me) — it is the "who am I + which workspaces do I belong to" call the app makes
// on load, before any workspace is scoped.
//
// Contract:
//   GET  /api/me                        → 200 { userId, workspaces: [...], activeWorkspaceId }  (AS-006)
//   POST /api/me/active-workspace { workspaceId } → 200 { activeWorkspaceId }                    (AS-006/007 switch)
//
// Each workspace carries the caller's role + the creating admin's display name so two
// "default"s disambiguate (GAP-002/AS-006). Switching to a workspace the caller does NOT
// belong to is refused (AS-008). The active workspace is the login-default landing only
// (C-005) — the request scope is always the /api/w/:workspaceId path, never this.

import { Elysia } from "elysia";
import { z } from "zod";
import { apiEnvelope } from "../http/envelope";
import { requireSession, type SessionResolver } from "../http/auth-gate";
import { validateBody } from "../http/validate";
import { NotFoundError } from "../http/errors";
import { listMyWorkspaces, type TenancyRepo } from "../workspace/tenancy";
import { createTenancyRepo } from "../workspace/tenancy-repo";
import type { DB } from "../db/client";

export const switchWorkspaceBodySchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
});

export interface MeRoutesDeps {
  db?: DB;
  repo?: TenancyRepo;
  resolveSession: SessionResolver;
  /** Read the actor's current active workspace id (server state), or null. */
  getActiveWorkspaceId?: (userId: string) => Promise<string | null>;
  /** Persist the actor's active workspace id (login-default landing — C-005). */
  setActiveWorkspaceId?: (userId: string, workspaceId: string) => Promise<void>;
}

export function meRoutes(deps: MeRoutesDeps) {
  const repo: TenancyRepo =
    deps.repo ??
    (() => {
      if (!deps.db) throw new Error("meRoutes requires either `repo` or `db`");
      return createTenancyRepo(deps.db);
    })();

  return apiEnvelope(new Elysia())
    .use(requireSession({ resolveSession: deps.resolveSession }))
    // GET /api/me — the bootstrap: my workspaces + role + the active one (AS-006).
    .get("/api/me", async ({ actor }) => {
      const workspaces = await listMyWorkspaces(actor.userId, { repo });
      const active = (await deps.getActiveWorkspaceId?.(actor.userId)) ?? null;
      // Default the active workspace to the first one I belong to if none is set yet.
      const activeWorkspaceId =
        active && workspaces.some((w) => w.id === active)
          ? active
          : (workspaces[0]?.id ?? null);
      return { userId: actor.userId, workspaces, activeWorkspaceId };
    })
    // POST /api/me/active-workspace — switch the active workspace (AS-006/AS-007).
    // Switching to one I do not belong to is refused (AS-008, existence-hiding 404).
    .post("/api/me/active-workspace", async ({ body, actor }) => {
      const { workspaceId } = validateBody(switchWorkspaceBodySchema, body);
      const workspaces = await listMyWorkspaces(actor.userId, { repo });
      if (!workspaces.some((w) => w.id === workspaceId)) {
        throw new NotFoundError(); // not a member → 404 (existence-hiding)
      }
      await deps.setActiveWorkspaceId?.(actor.userId, workspaceId);
      return { activeWorkspaceId: workspaceId };
    });
}
