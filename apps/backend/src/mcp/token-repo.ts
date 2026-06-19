// mcp-roundtrip S-001 — Drizzle-backed PAT repo: issue (with the per-user cap), verify
// (hash lookup + not-revoked + not-expired, re-run on EVERY request), list (metadata only,
// never the secret or hash), revoke, and the coalesced last_used_at bump.
//
// THIN glue over src/mcp/token.ts (the pure crypto/scope logic) + the api_tokens table.
// The active-token cap is enforced count-in-transaction (C-007/AS-025) so it can't be
// bypassed by minting concurrently to the limit; the version-serialization-style guard.

import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { apiTokens } from "../db/schema";
import type { DB } from "../db/client";
import {
  hashToken,
  mintPlaintextToken,
  normalizeScopes,
  shouldBumpLastUsed,
  TOKEN_PREFIX,
  verifyTokenHash,
  type Scope,
} from "./token";
import { MCP_ACTIVE_TOKEN_CAP } from "./rate-limit";

/** A verified token's resolved identity — what every authenticated MCP request acts under. */
export interface ResolvedToken {
  id: string;
  userId: string;
  /** The ONE workspace this token acts in (C-001 — derived from the token, not the path). */
  workspaceId: string;
  scopes: Scope[];
  lastUsedAt: Date | null;
}

/** A token's listing row — metadata + prefix ONLY (C-008/AS-020: never the full token/hash). */
export interface TokenListItem {
  id: string;
  name: string;
  workspaceId: string;
  scopes: Scope[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  /** Always exactly `anch_pat_` — the only fragment of the secret ever returned (AS-020). */
  prefix: string;
}

/** Thrown when issuance is refused (cap reached) — the route maps it to a clear error. */
export class TokenCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenCapError";
  }
}

export interface CreateTokenInput {
  userId: string;
  workspaceId: string;
  name: string;
  scopes: readonly unknown[];
  expiresAt?: Date | null;
}

export function createApiTokenRepo(
  db: DB,
  secret: string,
  opts: { activeTokenCap?: number } = {},
) {
  const cap = opts.activeTokenCap ?? MCP_ACTIVE_TOKEN_CAP;

  /** Active = not revoked AND not expired (expires_at null = never expires). */
  const activeWhere = (now: Date) =>
    and(
      isNull(apiTokens.revokedAt),
      or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
    );

  return {
    /**
     * Issue a new PAT. Validates+normalizes scopes (throws TokenScopeError), enforces the
     * per-user active-token cap (throws TokenCapError — AS-025), stores ONLY the hash, and
     * returns the plaintext exactly once (C-008/AS-020). The cap count + insert run inside one
     * transaction so two concurrent creates at the cap can't both slip through.
     */
    async create(input: CreateTokenInput): Promise<{ token: string; item: TokenListItem }> {
      const scopes = normalizeScopes(input.scopes);
      const now = new Date();
      const plaintext = mintPlaintextToken();
      const tokenHash = hashToken(plaintext, secret);

      const row = await db.transaction(async (tx) => {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(apiTokens)
          .where(and(eq(apiTokens.userId, input.userId), activeWhere(now)));
        if ((n ?? 0) >= cap) {
          throw new TokenCapError(
            `active token cap reached (${cap}); revoke an existing token before creating another`,
          );
        }
        const [inserted] = await tx
          .insert(apiTokens)
          .values({
            userId: input.userId,
            workspaceId: input.workspaceId,
            tokenHash,
            name: input.name,
            scopes,
            expiresAt: input.expiresAt ?? null,
          })
          .returning({
            id: apiTokens.id,
            name: apiTokens.name,
            workspaceId: apiTokens.workspaceId,
            scopes: apiTokens.scopes,
            lastUsedAt: apiTokens.lastUsedAt,
            expiresAt: apiTokens.expiresAt,
          });
        return inserted!;
      });

      return {
        token: plaintext,
        item: {
          id: row.id,
          name: row.name,
          workspaceId: row.workspaceId,
          scopes: row.scopes as Scope[],
          lastUsedAt: row.lastUsedAt,
          expiresAt: row.expiresAt,
          prefix: TOKEN_PREFIX,
        },
      };
    },

    /**
     * Verify a presented plaintext on EVERY request (C-001): O(1) indexed hash lookup, then
     * not-revoked + not-expired. Returns the resolved identity (id/user/workspace/scopes) or
     * null for any failure (wrong/revoked/expired/missing — AS-002/AS-010/AS-022). The
     * constant-time compare guards against a timing probe even after the indexed lookup.
     */
    async verify(plaintext: string, now: Date = new Date()): Promise<ResolvedToken | null> {
      if (typeof plaintext !== "string" || plaintext.length === 0) return null;
      const tokenHash = hashToken(plaintext, secret);
      const [row] = await db
        .select({
          id: apiTokens.id,
          userId: apiTokens.userId,
          workspaceId: apiTokens.workspaceId,
          scopes: apiTokens.scopes,
          tokenHash: apiTokens.tokenHash,
          expiresAt: apiTokens.expiresAt,
          revokedAt: apiTokens.revokedAt,
          lastUsedAt: apiTokens.lastUsedAt,
        })
        .from(apiTokens)
        .where(eq(apiTokens.tokenHash, tokenHash))
        .limit(1);
      if (!row) return null;
      // Defense-in-depth constant-time recheck (the indexed lookup already matched the hash).
      if (!verifyTokenHash(plaintext, row.tokenHash, secret)) return null;
      if (row.revokedAt) return null; // AS-002/AS-021/AS-022
      if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return null;
      return {
        id: row.id,
        userId: row.userId,
        workspaceId: row.workspaceId,
        scopes: row.scopes as Scope[],
        lastUsedAt: row.lastUsedAt,
      };
    },

    /**
     * Coalesced last_used_at bump (C-008): writes at most ~once/min/token, so a read-heavy
     * agent doesn't write the row on every call. No-op when the last bump is within the window.
     */
    async touchLastUsed(tokenId: string, lastUsedAt: Date | null, now: Date = new Date()) {
      if (!shouldBumpLastUsed(lastUsedAt, now)) return;
      await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, tokenId));
    },

    /**
     * List a user's ACTIVE tokens (AS-020) — metadata + the `anch_pat_` prefix ONLY. The
     * select never reads token_hash, so the secret and its hash are structurally unable to
     * leak through this surface (C-008).
     */
    async listActive(userId: string, now: Date = new Date()): Promise<TokenListItem[]> {
      const rows = await db
        .select({
          id: apiTokens.id,
          name: apiTokens.name,
          workspaceId: apiTokens.workspaceId,
          scopes: apiTokens.scopes,
          lastUsedAt: apiTokens.lastUsedAt,
          expiresAt: apiTokens.expiresAt,
        })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, userId), activeWhere(now)))
        .orderBy(apiTokens.createdAt);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        workspaceId: r.workspaceId,
        scopes: r.scopes as Scope[],
        lastUsedAt: r.lastUsedAt,
        expiresAt: r.expiresAt,
        prefix: TOKEN_PREFIX,
      }));
    },

    /**
     * Revoke a token the user owns (AS-021). Scoped by (id, userId) so a user can't revoke
     * another user's token. Idempotent: sets revoked_at if not already set. Returns whether a
     * row was affected (false = not found / not owned / already revoked).
     */
    async revoke(tokenId: string, userId: string, now: Date = new Date()): Promise<boolean> {
      const updated = await db
        .update(apiTokens)
        .set({ revokedAt: now })
        .where(
          and(
            eq(apiTokens.id, tokenId),
            eq(apiTokens.userId, userId),
            isNull(apiTokens.revokedAt),
          ),
        )
        .returning({ id: apiTokens.id });
      return updated.length > 0;
    },
  };
}

export type ApiTokenRepo = ReturnType<typeof createApiTokenRepo>;
