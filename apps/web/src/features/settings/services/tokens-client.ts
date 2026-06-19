import { api } from "@/lib/api";
import type { EdenResult } from "@/lib/api/use-api-query";
import type { CreatedToken, CreateTokenInput, TokenListItem } from "@/features/settings/types/tokens";

// mcp-roundtrip S-001 (AS-020/AS-021) — typed request thunks for the PAT backend
// (`GET/POST /api/me/tokens`, `DELETE /api/me/tokens/:id`).
//
// Same pattern + rationale as workspaces/services/client.ts: the backend mounts these routes
// CONDITIONALLY, so the exported treaty type doesn't statically surface them through chaining.
// We reach them through the same runtime treaty client (it resolves paths dynamically) and
// annotate the return ourselves. `App` stays the real type — this is the one place the cast lives,
// and component tests mock THIS module, so the cast is never exercised under test.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const treaty = api as any;

/** GET /api/me/tokens — the caller's tokens (metadata + `anch_pat_` prefix only; AS-020 / C-008). */
export function listTokens(): Promise<EdenResult<{ tokens: TokenListItem[] }>> {
  return treaty.api.me.tokens.get() as Promise<EdenResult<{ tokens: TokenListItem[] }>>;
}

/** POST /api/me/tokens — mint a workspace-bound, scoped token. The 201 carries the plaintext
 *  token ONCE (shown in the reveal card). 400 bad scope / not-a-member, 409 at the per-user cap. */
export function createToken(input: CreateTokenInput): Promise<EdenResult<CreatedToken>> {
  return treaty.api.me.tokens.post(input) as Promise<EdenResult<CreatedToken>>;
}

/** DELETE /api/me/tokens/:id — revoke a token (AS-021). */
export function revokeToken(id: string): Promise<EdenResult<{ revoked: boolean }>> {
  return treaty.api.me.tokens({ id }).delete() as Promise<EdenResult<{ revoked: boolean }>>;
}
