import { loadConfig } from "./config/env";
import { createDb } from "./db/client";
import { createApp } from "./app";
import { createAuth } from "./auth/auth";
import { betterAuthSessionResolver } from "./http/auth-gate";
import {
  createResolveDocRole,
  createLoadShareConfig,
  createIsDocOwner,
} from "./sharing/resolve-doc-role-repo";

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

// canViewDoc deps (existence-hiding). The invite/workspace-membership lookups stay
// permissive in this v0 wiring (treat authenticated users as invited/members so a
// visible doc reads); tightening these to the concrete doc_members / workspace reads
// is a follow-up. The accessDeps shape is what canViewDoc consumes.
const sharedAccessDeps = {
  isInvited: () => true,
  isWorkspaceMember: () => true,
};

// SHARING SEAMS CLOSED (sharing-permissions). The interim placeholders the earlier
// route clusters used (resolveDocRole → "owner"/"editor"; loadShareConfig → OFF) are
// replaced with the CONCRETE Drizzle resolvers:
//   - resolveDocRole: real effective-role over invited (active doc_members) + link
//     (share_links.role when general-access admits) roles. Highest wins (C-002).
//   - loadShareConfig: reads share_links.guest_commenting.
//
// OWNER-SOURCE SEAM CLOSED (auth-routes S-002, C-003): S-001 added `docs.owner_id`
// (the authenticated publisher), so "is this user the owner" is now resolvable. We wire
// the CONCRETE `createIsDocOwner(db)` (reads docs.owner_id) in place of the old
// `async () => false` placeholder. The owner now folds into effectiveRole → highest wins
// (AS-003/AS-005), so the doc owner manages sharing for real, while a viewer/commenter
// still resolves to their lesser role → denied (AS-004/C-004).
const isWorkspaceMember = () => true;
const sharedResolveDocRole = createResolveDocRole(db, {
  isOwner: createIsDocOwner(db), // ← concrete owner read (auth-routes S-002 closes the seam)
  isWorkspaceMember,
});
const concreteLoadShareConfig = createLoadShareConfig(db);

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
    resolveDocRole: sharedResolveDocRole,
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
    loadShareConfig: concreteLoadShareConfig,
  },
  // workspace-project S-001: first-run POST /api/setup over the real DB (create the
  // single workspace + claim admin; later signups become members via the auth hook).
  setup: { db, resolveSession },
  // sharing-permissions S-001/S-003/S-004: owner-only access/invites/link controls.
  // Owner gate reads the concrete resolver (owner source still seamed to false — see
  // above). Mail wiring is omitted here; the prod enqueueInvite degrades to a no-op
  // transport until the mail cluster wires the live transport selection.
  sharing: {
    db,
    resolveSession,
    resolveDocRole: sharedResolveDocRole,
    // Manage-sharing gate (C-007) reads editors_can_share from here (reuses the same
    // concrete loader as annotation-core; the superset return shape covers both).
    loadShareConfig: concreteLoadShareConfig,
    accessDeps: sharedAccessDeps,
  },
}).listen(cfg.PORT);

console.log(`anchord on http://localhost:${cfg.PORT} (${cfg.NODE_ENV})`);
export type App = typeof app;
