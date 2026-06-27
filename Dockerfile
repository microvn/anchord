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

# Web build stage (self-host S-005) — building the SPA needs the FULL dev toolchain (Vite).
# INSTALL with bun (resolves the workspace `workspace:*` deps + bun.lock), but BUILD with NODE.
# Why: on the x64 Linux bun build, bun's module resolution is broken for the vite/rollup toolchain
# — the `.bin/vite` shim resolves vite's `../dist/node/cli.js` from the wrong dir, and bun can't
# resolve rollup's `rollup/parseAst` subpath export — so EVERY bun-run build (`bun run`, `--filter`,
# `bunx --bun vite`, programmatic `import("vite")`) fails on x64 (arm64 happens to dodge it). Node's
# resolution handles both correctly. So: node base image (has node) + bun installed via npm for the
# workspace install, then `node …/vite` for the actual build.
FROM node:20-slim AS webbuild
WORKDIR /app
RUN npm install -g bun@1.3.13
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/anchor/package.json ./packages/anchor/package.json
RUN bun install --frozen-lockfile
COPY . .
# Build with Node (not bun) — Node resolves vite's bin + rollup subpaths correctly on x64.
RUN cd apps/web && node node_modules/.bin/vite build

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
