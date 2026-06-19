import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApiQuery } from "@/lib/api/use-api-query";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { listTokens, createToken, revokeToken } from "@/features/settings/services/tokens-client";
import type { CreatedToken, CreateTokenInput, TokenListItem } from "@/features/settings/types/tokens";

// mcp-roundtrip S-001 (AS-020/AS-021) — React Query owns the token list (server state). The list
// read goes through the shared `useApiQuery` (envelope-peeled, session-bounce centralized); create
// and revoke are mutations that invalidate the list so the UI reflects the server after each write.

const TOKENS_KEY = ["me", "tokens"] as const;

/** AS-020: the caller's active tokens — metadata + `anch_pat_` prefix only. */
export function useTokens() {
  return useApiQuery<{ tokens: TokenListItem[] }>(TOKENS_KEY, () => listTokens());
}

/**
 * Create a token. Resolves to the 201 payload (incl. the one-time plaintext `token`) so the caller
 * can show the reveal card; invalidates the list so the new row appears. The error is surfaced to
 * the caller (a 409 at the per-user cap → a clear message, not a silent failure).
 */
export function useCreateToken() {
  const queryClient = useQueryClient();
  return useMutation<CreatedToken, Error, CreateTokenInput>({
    mutationFn: async (input) => {
      const res = unwrapEnvelope<CreatedToken>(await createToken(input));
      if (res.error || !res.data) throw toCreateError(res.error);
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
    },
  });
}

/** AS-021: revoke a token, then invalidate the list so the row disappears from the active set. */
export function useRevokeToken() {
  const queryClient = useQueryClient();
  return useMutation<{ revoked: boolean }, Error, string>({
    mutationFn: async (id) => {
      const res = unwrapEnvelope<{ revoked: boolean }>(await revokeToken(id));
      if (res.error || !res.data) throw new Error("revoke-failed");
      return res.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
    },
  });
}

// Map a create error to a human message. A 409 means the user hit the per-user active-token cap
// (default 10, C-007/AS-025); anything else is a generic create failure.
function toCreateError(error: unknown): Error {
  const status = (error as { status?: number } | null)?.status;
  if (status === 409) {
    return new Error("You've reached the limit of 10 active tokens. Revoke one to create another.");
  }
  if (status === 400) {
    return new Error("Couldn't create that token. Check the workspace and scopes and try again.");
  }
  return new Error("Couldn't create the token. Try again.");
}
