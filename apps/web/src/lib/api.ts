import { treaty } from "@elysiajs/eden";
import type { App } from "backend";

// C-004: the typed client reaches the backend on the SAME ORIGIN as the app (dev: Vite
// proxies /api → the backend; prod: the backend serves this built app). We point treaty
// at the current origin so requests go to /api/... on the same host.
//
// C-001: `credentials: "include"` makes the browser send the better-auth session cookie
// on every request — identity rides the cookie, NOT a client-stored token. There is no
// localStorage/sessionStorage token anywhere in this client.
//
// The `import type { App }` above is what gives the client end-to-end types. It resolves
// to apps/backend/src/index.ts (the workspace `backend` package's "." export, which
// re-exports `export type App = typeof app`). Keep it a TYPE import and avoid tsconfig
// `paths` into backend src — either would collapse the treaty types to `any`.
const origin =
  typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";

export const api = treaty<App>(origin, {
  fetch: { credentials: "include" },
});

export type Api = typeof api;
