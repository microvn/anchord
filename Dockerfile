FROM oven/bun:1.3-alpine AS deps
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
FROM oven/bun:1.3-alpine AS webbuild
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/anchor/package.json ./packages/anchor/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun --filter web build

FROM oven/bun:1.3-alpine AS release
WORKDIR /app
ENV NODE_ENV=production
# self-host S-005 / C-007: serve the built web app from this absolute path (the instance falls
# back to its index.html for client-side routes; backend surfaces are never shadowed).
ENV WEB_ROOT=/app/apps/web/dist
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Overlay the built SPA (apps/web/dist is not in the build context — it's produced in webbuild).
COPY --from=webbuild /app/apps/web/dist ./apps/web/dist
EXPOSE 3000
# Run boot migration then serve (fail-closed: app won't serve if migrate fails — C-001).
# Scripts are workspace-filtered to the backend package.
CMD ["sh", "-c", "bun --filter backend db:migrate && bun --filter backend start"]
