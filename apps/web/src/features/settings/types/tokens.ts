// mcp-roundtrip S-001 (AS-020/AS-021) — the PAT-management surface types. A thin local mirror of
// the api_tokens metadata the backend returns from /api/me/tokens. The wire shape is enforced by
// the typed Eden client; this file is what the Developer-section UI reads.
//
// C-008: the list endpoint returns metadata + the `anch_pat_` PREFIX ONLY — never the full token
// or its stored hash. The plaintext token exists exactly once, in the 201 create response
// (`CreatedToken.token`), and is shown a single time in the reveal card (AS-020 reveal-once).

/** The six real token scopes (C-008/C-009). The prototype's `comments:*` labels are stale —
 *  the backend uses `annotations:*`, plus a `projects:*` pair the prototype never had. */
export type TokenScope =
  | "docs:read"
  | "docs:write"
  | "annotations:read"
  | "annotations:write"
  | "projects:read"
  | "projects:write";

/** Scope id + human description, in the order the create dialog lists them. */
export const SCOPE_OPTIONS: { id: TokenScope; desc: string }[] = [
  { id: "docs:read", desc: "List, read, search docs" },
  { id: "docs:write", desc: "Create docs + publish versions" },
  { id: "annotations:read", desc: "Pull annotations + list comments" },
  { id: "annotations:write", desc: "Reply + resolve threads" },
  { id: "projects:read", desc: "List + read projects" },
  { id: "projects:write", desc: "Create projects" },
];

/** Presets mirror the backend's TOKEN_SCOPE_PRESETS (authoritative). */
export const SCOPE_PRESETS: { label: string; scopes: TokenScope[] }[] = [
  { label: "READ-ONLY", scopes: ["docs:read", "annotations:read", "projects:read"] },
  { label: "PUBLISH", scopes: ["docs:read", "docs:write", "projects:read", "projects:write"] },
  {
    label: "FULL MCP",
    scopes: [
      "docs:read",
      "docs:write",
      "annotations:read",
      "annotations:write",
      "projects:read",
      "projects:write",
    ],
  },
];

/** The real MCP tool names the server exposes (S-002/S-004/S-006), shown in the connect block. */
export const MCP_TOOLS = [
  "anchord_list_documents",
  "anchord_read_document",
  "anchord_search_documents",
  "anchord_create_document",
  "anchord_update_document",
  "anchord_pull_annotations",
  "anchord_list_comments",
  "anchord_reply_comment",
  "anchord_resolve_comment",
  "anchord_list_projects",
  "anchord_read_project",
  "anchord_create_project",
] as const;

/** One token as the list endpoint returns it (GET /api/me/tokens → data.tokens[]). Metadata +
 *  prefix ONLY — no `token`, no `hash` (C-008 / AS-020). */
export interface TokenListItem {
  id: string;
  name: string;
  workspaceId: string;
  workspaceName: string | null;
  scopes: TokenScope[];
  /** The displayable prefix, e.g. "anch_pat_". Never the full secret. */
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** The 201 create response: the list item PLUS the plaintext token, shown once and never again. */
export interface CreatedToken extends TokenListItem {
  /** The full plaintext token (`anch_pat_…`). Present only here, only at creation (C-008). */
  token: string;
}

/** POST body for creating a token. */
export interface CreateTokenInput {
  name: string;
  workspaceId: string;
  scopes: TokenScope[];
  /** ISO date string, or undefined for "never expires". */
  expiresAt?: string;
}
