import { api } from "../../lib/api";
import type { EdenResult } from "../../lib/use-api-query";

// Typed request thunks for the auth-ui backend reads/writes that are NOT part of
// better-auth's own /api/auth/* protocol:
//  - GET  /api/auth-providers  → which OAuth buttons to render (GAP-002 / AS-007)
//  - POST /api/invite/accept   → accept a per-doc invite via its accept-link (S-003)
//
// WHY a wrapper and not raw `api.api...` at each call site: the backend composes these
// routes CONDITIONALLY (`if (deps.authProviders) …`, `if (deps.invite) …` in
// apps/backend/src/app.ts), so `App = typeof app` cannot statically widen to include them.
// We reach them through the same runtime treaty client (resolves paths dynamically) and
// annotate the return here — the ONE cast site for auth-ui, mirroring features/workspaces/
// client.ts. Component tests MOCK this module, so the cast is never exercised under test.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

/** GET /api/auth-providers — enabled OAuth provider names (GAP-002 / AS-007). */
export function fetchAuthProviders(): Promise<EdenResult<unknown>> {
  return treaty.api["auth-providers"].get() as Promise<EdenResult<unknown>>;
}

/** POST /api/invite/accept — accept a per-doc invite via {inviteId, token} from its link (S-003). */
export function acceptDocInvite(inviteId: string, token: string): Promise<EdenResult<unknown>> {
  return treaty.api.invite.accept.post({ inviteId, token }) as Promise<EdenResult<unknown>>;
}
