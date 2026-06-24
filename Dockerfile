# syntax=docker/dockerfile:1
#
# Release image for the pixel-agents stream server.
# Build:  docker build -t pixel-agents .
# Run:    docker run --rm -e PIXEL_STREAM_TOKEN=<secret> -p 6161:6161 -p 7171:7171 pixel-agents
#
# Ports / paths are overridable via env (see the runtime stage):
#   PIXEL_STREAM_PORT        viewer / frontend port (default 6161)
#   PIXEL_STREAM_FEED_PORT   client-feed port       (default 7171)
#   PIXEL_STREAM_HOST        bind address           (default 0.0.0.0)
#   PIXEL_STREAM_TOKEN       shared AUTH token       (REQUIRED — no default)
#   PIXEL_STREAM_DATA_DIR    config + layout DB dir  (default /data; mount a volume)
#
# node:24 is required for the stable built-in node:sqlite (layout database).

# ── Build: install workspace deps + produce the release (dist/) ──────────────
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
# pnpm-workspace.yaml's allowBuilds keeps dependency build scripts disabled.
RUN pnpm install --frozen-lockfile
RUN pnpm build

# ── Runtime deps: only the server's production deps (the @fastify externals) ──
# Just package.json (no workspace file) → a standalone prod install of the few
# Fastify packages that dist/stream.js loads at runtime. None ship build scripts.
FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json ./
RUN pnpm install --prod

# ── Runtime: node + dist/ + prod node_modules only ───────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PIXEL_STREAM_HOST=0.0.0.0 \
    PIXEL_STREAM_PORT=6161 \
    PIXEL_STREAM_FEED_PORT=7171 \
    PIXEL_STREAM_DATA_DIR=/data
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./

# Persisted state (config.json, <ns>-state.json, layouts.db) lives in /data.
# Created up front and owned by the unprivileged `node` user; declared a VOLUME
# so it survives container restarts (mount your own with -v to keep it on host).
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Viewer (frontend) + client-feed ports — defaults; override the env vars above
# and map the matching ports with -p when you change them.
EXPOSE 6161 7171

# Run unprivileged.
USER node

# /api/health on the viewer port (no auth) — used as the container healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PIXEL_STREAM_PORT||6161)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# PIXEL_STREAM_TOKEN must be provided at run time, else the server exits.
CMD ["node", "dist/stream.js"]
