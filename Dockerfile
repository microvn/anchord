FROM oven/bun:1.3.13-slim AS deps
WORKDIR /app
# Workspace install: root manifest + lockfile + every workspace member manifest the
# lockfile references. backend depends on @anchord/anchor (workspace:*), so its manifest
# (packages/anchor) MUST be present or `workspace:*` fails to resolve; apps/web's manifest
# is copied too so the frozen-lockfile workspace check is satisfied (its dev-only Vite/React
# toolchain is skipped by --production).
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/anchor/package.json ./packages/anchor/package.json
RUN bun install --frozen-lockfile --production

# Web build stage (self-host S-005) — building the SPA needs the FULL dev toolchain (Vite),
# so this stage does a non-production install, then `vite build` → apps/web/dist.
FROM oven/bun:1.3.13-slim AS webbuild
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/anchor/package.json ./packages/anchor/package.json
RUN bun install --frozen-lockfile
COPY . .
# Build via Vite's PROGRAMMATIC API, bypassing the workspace `.bin/vite` shim entirely.
# On the x64 Linux bun build, that shim makes bun resolve vite's relative `../dist/node/cli.js`
# from the SHIM's dir instead of vite's real `bin/` → "Cannot find module '../dist/node/cli.js'".
# `bun run build`, `bun --filter`, and `bunx --bun vite` ALL route through the shim → all fail
# (arm64's layout happens to dodge it). `import("vite")` resolves the package main, never the bin,
# so build() runs clean. Run from apps/web so vite picks up its vite.config.ts.
RUN cd apps/web && bun -e 'const { build } = await import("vite"); await build();'

FROM oven/bun:1.3.13-slim AS release
WORKDIR /app
ENV NODE_ENV=production
# self-host S-005 / C-007: serve the built web app from this absolute path (the instance falls
# back to its index.html for client-side routes; backend surfaces are never shadowed).
ENV WEB_ROOT=/app/apps/web/dist
COPY --from=deps /app/node_modules ./node_modules
# Workspace-member deps live in the member's OWN node_modules (a symlink farm into
# the root .bun store), NOT hoisted to root — so the backend's node_modules must be
# copied too, or `drizzle-orm/postgres-js` (and every other backend dep) fails to
# resolve at boot. anchor has no deps and web isn't run at release, so only backend.
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY . .
# Overlay the built SPA (apps/web/dist is not in the build context — it's produced in webbuild).
COPY --from=webbuild /app/apps/web/dist ./apps/web/dist
EXPOSE 3000
# Run boot migration then serve (fail-closed: app won't serve if migrate fails — C-001).
# Scripts are workspace-filtered to the backend package.
CMD ["sh", "-c", "bun --filter backend db:migrate && bun --filter backend start"]
