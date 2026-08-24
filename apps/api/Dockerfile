# Build context is the repo root so the pnpm workspace resolves.
#   docker build -f apps/api/Dockerfile .

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ── deps ──────────────────────────────────────────────────────────────────
# Manifests only, so a source-only change reuses the cached install layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile

# ── build ─────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# Prisma 7 emits a TypeScript client, so generate must precede compilation.
RUN pnpm --filter api db:generate && pnpm --filter api build

# ── runtime ───────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

# The whole tree is copied because pnpm's node_modules uses relative symlinks
# that only resolve inside /app. Trading image size for a build that does not
# depend on `pnpm deploy` behaviour.
COPY --from=build /app /app

# Prisma CLI + schema stay in the image so migrations can be applied on deploy.
WORKDIR /app/apps/api

RUN addgroup -S nodejs && adduser -S nestjs -G nodejs && chown -R nestjs:nodejs /app
USER nestjs

EXPOSE 3001

# Overridden by the worker service in docker-compose.
CMD ["node", "dist/main"]
