import { loadConfig } from "./config/env";
import { createDb } from "./db/client";
import { createApp } from "./app";
import { createAuth } from "./auth/auth";
import { betterAuthSessionResolver } from "./http/auth-gate";

const cfg = loadConfig(); // refuses to start on invalid/missing config (S-002, incl. SMTP C-008)
const { db, dbCheck } = createDb(cfg.DATABASE_URL);

// S-001: better-auth bound to the real Postgres DB; APP_SECRET signs the session cookie.
// S-002: pass through OAuth creds — each provider is configured only when env supplied both.
const auth = createAuth(db, {
  secret: cfg.APP_SECRET,
  baseURL: `http://localhost:${cfg.PORT}`,
  oauth: cfg.oauth,
});

const resolveSession = betterAuthSessionResolver(auth);

// SHARING SEAM (sharing-permissions cluster, built next): the doc-scoped effective
// role (owner/invite/link general-access precedence) and the invite/workspace
// membership lookups for canViewDoc are owned by that cluster's concrete repo. Until
// its routes are mounted, wire interim impls here:
//   - resolveDocRole: any authenticated user is treated as `editor` for now, so the
//     publish→edit/restore flow works in the running app. This OPENS writes more than
//     v0's final model (owner/editor only) and is REPLACED when sharing routes land.
//   - accessDeps: treat authenticated users as invited/members so visible docs read.
// Both are honest placeholders, not the final authz — flagged here so the swap is
// obvious when sharing-permissions wires its concrete repo.
const sharedAccessDeps = {
  isInvited: () => true,
  isWorkspaceMember: () => true,
};

// Shared interim doc-scoped role resolver (the sharing seam). Until sharing routes
// land, any authenticated user is treated as `owner` for now so the full annotation
// flow (comment/resolve/suggest + owner-only suggestion decide) works in the running
// app. This OPENS writes more than v0's final model and is REPLACED when the sharing
// cluster wires its concrete repo. Honest placeholder, flagged for the swap.
const sharedResolveDocRole = async (): Promise<"owner"> => "owner";

// Guest-commenting toggle seam (sharing-permissions). The concrete resolver reads
// share_links.guest_commenting; until those routes land, default OFF so the running
// app never silently accepts anonymous comments. Swapped when sharing wires its repo.
const interimLoadShareConfig = async () => ({ guestCommentingEnabled: false });

const app = createApp({
  dbCheck,
  corsOrigin: cfg.CORS_ORIGIN === "*" ? true : cfg.CORS_ORIGIN.split(","),
  authHandler: auth.handler,
  // render-publish S-001: enveloped, session-gated POST /api/docs over the real DB.
  docs: { db, resolveSession },
  // versioning-diff S-001..S-004: version create/title/history/restore/diff over the real DB.
  versions: {
    db,
    resolveSession,
    resolveDocRole: async () => "editor",
    accessDeps: sharedAccessDeps,
  },
  // annotation-core S-001..S-007: annotation create/list, reply + guest comment,
  // resolve/reopen, suggestion create/decide over the real DB. Shares the interim
  // role/access seams; guest commenting defaults OFF until the sharing cluster lands.
  annotations: {
    db,
    resolveSession,
    resolveDocRole: sharedResolveDocRole,
    accessDeps: sharedAccessDeps,
    loadShareConfig: interimLoadShareConfig,
  },
}).listen(cfg.PORT);

console.log(`anchord on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
export type App = typeof app;
