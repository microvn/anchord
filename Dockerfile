FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
# Workspace install: root manifest + lockfile + the backend package manifest.
COPY package.json bun.lock ./
COPY apps/backend/package.json ./apps/backend/package.json
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS release
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
# Run boot migration then serve (fail-closed: app won't serve if migrate fails — C-001).
# Scripts are workspace-filtered to the backend package.
CMD ["sh", "-c", "bun --filter backend db:migrate && bun --filter backend start"]
