FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3-alpine AS release
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
# Run boot migration then serve (fail-closed: app won't serve if migrate fails — C-001).
CMD ["sh", "-c", "bun run db:migrate && bun run start"]
