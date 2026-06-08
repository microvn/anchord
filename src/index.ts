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
const versionsAccessDeps = {
  isInvited: () => true,
  isWorkspaceMember: () => true,
};

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
    accessDeps: versionsAccessDeps,
  },
}).listen(cfg.PORT);

console.log(`anchord on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
export type App = typeof app;
