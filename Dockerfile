# ================================================================
# Tessel — Multi-stage Dockerfile
# Stage 1: install dependencies (frozen lockfile, production only)
# Stage 2: lean runtime image (no dev tooling)
# ================================================================

# ── Stage 1: dependency installation ────────────────────────────
FROM oven/bun:1.3.11-alpine AS deps

WORKDIR /app

# Copy only files bun needs to resolve the lockfile
COPY package.json bun.lock ./

# --frozen-lockfile: reproducible build, fails if bun.lockb is stale
# --production: skip devDependencies (vitest, @types/*, etc.)
RUN bun install --frozen-lockfile --production

# ── Stage 2: runtime image ───────────────────────────────────────
FROM oven/bun:1.3.11-alpine AS runner

WORKDIR /app

# 以 root 创建运行时目录并授权给 bun 用户，再切换用户。
# /app/data 是 graph store (data/graph-runs.db) 等运行时文件的存储位置；
# docker-compose 会把它挂为 named volume，但首次创建时挂载点的 owner 是
# root —— 必须在 image 里预先创建并 chown，否则 bun 用户 mkdir / sqlite
# open 都会因 permission denied 启动失败。
RUN mkdir -p /app/logs /app/data && chown -R bun:bun /app/logs /app/data

# Reuse the 'bun' user (uid 1000) that ships with the official image
USER bun

# Copy dependency tree from deps stage
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules

# Copy application source (.dockerignore excludes node_modules, .env, logs, .git)
COPY --chown=bun:bun . .

# No ports exposed — Slack Socket Mode is outbound-only (client WebSocket)
# If src/ui/server.ts is enabled later, add: EXPOSE 3000

# Health check: verify bun runtime is alive
# For a richer check, replace with: curl -fsS http://localhost:PORT/health || exit 1
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun --eval "process.exit(0)" || exit 1

ENV NODE_ENV=production

ENTRYPOINT ["bun", "run", "src/main.ts"]
