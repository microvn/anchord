# FRONTEND.md

Conventions for `apps/web` — anchord's frontend. Read this before adding a file, a
hook, or a feature, so the structure stays uniform.

These conventions **adapt** (they do not adopt wholesale) the borrowed
`temple-live-stream/FRONTEND_TECHNICAL_GUIDE.md`. That guide assumes Next.js App Router,
axios, and Zustand global stores — anchord runs a different stack, so we kept the guide's
organizing ideas (feature folders, an API-infra layer, the `@/` alias, internal sub-layering)
and dropped the stack-specific parts. Where this doc and that guide disagree, **this doc wins.**

## Stack

Vite + React 19 + React Router 7 + Eden treaty + better-auth + React Query (TanStack) +
React Hook Form + Zod + Tailwind 4. One test runner: `bun test` (happy-dom via
`test/setup.ts`). No Next.js, no axios, no Zustand, no Vitest.

### Eden treaty, not axios

The API client is `@elysiajs/eden`'s treaty, typed end-to-end against the backend's `App`
type. There is no axios and no hand-written fetch wrapper. `src/lib/api/` owns the treaty
instance plus the error/envelope helpers; a feature talks to the backend only through its
own `client.ts` (typed request thunks built on `@/lib/api`). Do not introduce axios or call
`fetch` directly from a component.

The one load-bearing detail: `src/lib/api.ts` keeps `import type { App } from "backend"` as a
**type-only** import of the workspace package. Aliasing it into backend source collapses
Eden's end-to-end types to `any` — never rewrite that import.

### React Query for server state, `useState` for local — no Zustand

Server state (anything the backend owns) lives in React Query: queries, mutations, and the
cache are the single source of truth. Local, ephemeral UI state (open/closed, a draft input,
a hover target) lives in `useState`/`useReducer` inside the component that owns it. **There is
no Zustand store and we are not adding one** — the guide's global-store pattern is rejected
on purpose. If two distant components need the same server data, they both read the same
React Query key; they do not share a client store.

### React Router, not Next App Router

Routing is React Router 7 (`createBrowserRouter`, loaders/guards in `src/app/`). There is no
`app/` directory, no file-based routing, no server components, no `"use client"`. Route guards
and providers live in `src/app/`.

## Directory layout

```
src/
  app/         shell, providers, route guards, query-client — the FE "core"
  lib/
    api/       API infra: api, api-error, auth-client, use-api-query (barrel: @/lib/api)
    *.ts       pure utils only: utils, initials, session-expiry
  hooks/       GLOBAL (non-feature) hooks: use-breakpoint (also exports useIsMobile)
  components/  shared primitives + ui/ (radix/shadcn-style wrappers)
  features/<feature>/
    components/   UI .tsx (+ co-located tests)
    hooks/        use-* hooks (omit the dir when the feature has none)
    client.ts     Eden request thunks — the feature's service
    types.ts      shared wire/domain types (see contract below)
    *.ts          plain helpers at the feature root
```

`src/lib/api/` is the API-infra layer (request + envelope). `use-api-query` lives there, with
the infra it wraps — not in `src/hooks/`. `src/lib/` root is pure utilities only. `src/hooks/`
is for global hooks that aren't owned by a feature.

## Feature layering

Every feature follows the same internal shape: UI components under `components/`, `use-*`
hooks under `hooks/` (omitted when the feature has no hooks — never create an empty `hooks/`),
and `client.ts` + `types.ts` + plain helpers at the feature root. This is uniform across all
features, large and small — uniformity was chosen over the minor over-engineering of
sub-folders for a 6-file feature.

### The `client.ts` + `types.ts` contract

- **`client.ts`** — the feature's service: typed Eden request thunks, built on `@/lib/api`.
  Every backend call a feature makes goes through here. Wire-shape types that exist only to
  describe a request/response may stay co-located in `client.ts` (it's already the home of the
  service that produces them).
- **`types.ts`** — domain/wire types the feature's UI consumes that are **shared across 2+
  files** and don't belong to a specific module. Create it only when such a type exists. A
  single-component prop type stays co-located in that component — do not hoist it. Do not create
  an empty `types.ts` just for symmetry; a feature with no cross-file shared type simply has none
  (`auth` and `sharing` are like this today — `auth`'s only shared type is single-file, and
  `sharing`'s shared types are its `client.ts` service contract).

## File naming

**kebab-case for every file** — `sign-in-screen.tsx`, `use-compose.ts`, `share-dialog.tsx`.
No PascalCase filenames, even for component files. The one capitalized name is `FRONTEND.md`
itself (a doc, by convention); everything under `src/` is kebab-case.

## Imports

- **Cross-module imports use the `@/` alias** — `@/lib/api`, `@/features/docs/client`,
  `@/hooks/use-breakpoint`. Never `../../lib/api`. `@/*` maps to `./src/*` (declared in
  `tsconfig.json`). This keeps an import's target legible without counting `../` hops.
- **Same-directory sibling imports stay relative** — `./types`, `./doc-card`. Don't rewrite a
  sibling import to `@/…`.
- **`import type { App } from "backend"`** stays a type-only import of the workspace package
  (see Eden, above) — never aliased into backend source.

## Tests

Tests use `bun test` (one runner; no Vitest migration).

- **Feature tests co-locate with their feature** — a feature's `*.test.tsx` lives inside
  `src/features/<feature>/` (under `components/` next to the component it covers, or at the
  feature root for module tests), so code and its tests move and review together. Tests reach
  their subject as a sibling (`./`) or via `@/…`, including `mock.module("@/features/<f>/client", …)`.
- **Infra / app-root tests stay central** in `apps/web/test/` — the app-shell, shared
  primitives, and API/hook infra aren't owned by any one feature (`smoke`, `header`, `sidebar`,
  `breakpoint`, `eden-type`, `design-system-shell`, `states`). The harness `test/setup.ts` stays
  in `test/` and is preloaded by `bunfig.toml` (`preload = ["./test/setup.ts"]`) — never move it.

### Known gap: co-located tests aren't typechecked

`tsconfig.json` has `exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"]`, so co-located tests
are **not** covered by `bun typecheck`. This preserves the pre-refactor invariant (tests were
centralized and excluded before co-location). The trade-off: there are roughly 53 latent type
errors in the test files that `tsc` doesn't currently surface. `bun test` still runs and passes
them; the type-level gap is deferred, not fixed. Removing the exclude (and clearing those errors)
is future work.

## Verify

```
cd apps/web && bun typecheck && bun test
```

Both must be green before any structural change is considered done.
