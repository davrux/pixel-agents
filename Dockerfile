# syntax=docker/dockerfile:1
#
# Release image for the pixel-agents server (Colyseus authoritative server +
# Phaser client, served as a static build from the same origin).
#
# Build:  docker build -t pixel-agents .
# Run:    docker run --rm -e PIXEL_ADMIN_TOKEN=<secret> -p 6161:6161 \
#                 -v pixel-data:/data pixel-agents
#
# Single port: the browser, Colyseus and the agent feed (/feed) all share it.
#
# Env (see server/src/index.ts + server/src/paths.ts):
#   PIXEL_STREAM_PORT        viewer + Colyseus + /feed port (default 6161)
#   PIXEL_STREAM_HOST        bind address           (default 0.0.0.0)
#   PIXEL_ADMIN_TOKEN        admin login token: presenting it at login makes that
#                            user an admin (and creates them); empty → open dev
#                            mode (no login). Agents use their own per-user token.
#   PIXEL_STREAM_DATA_DIR    SQLite database (pixel.db; default /data, mount a volume)
#
# node:24 is required for the built-in node:sqlite (sessions + layout database).
#
# The server's @colyseus/schema classes rely on TypeScript legacy decorators and
# a tsconfig path-map to @pixel/shared, so it runs directly from source via tsx
# (no fragile bundling step). The frontend is a normal static vite build.

# ── Build: install workspace deps + build the Phaser client (client/dist) ────
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
# pnpm-workspace.yaml's allowBuilds gates dependency build scripts explicitly.
RUN pnpm install --frozen-lockfile
RUN pnpm run build

# ── Runtime: node + the whole workspace tree (source, deps, client/dist, assets)
# tsx (a server devDependency) runs the TypeScript server in place.
FROM node:24-slim AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production \
    PIXEL_STREAM_HOST=0.0.0.0 \
    PIXEL_STREAM_PORT=6161 \
    PIXEL_STREAM_DATA_DIR=/data
COPY --from=build /app /app

# Persisted state (SQLite sessions + layouts) lives in /data; declared a VOLUME
# so it survives container restarts (mount your own with -v to keep it on host).
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Single port for viewer + Colyseus + /feed (override PIXEL_STREAM_PORT and the
# matching -p mapping if you change it).
EXPOSE 6161

USER node

# /health on the viewer port (no auth) — used as the container healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PIXEL_STREAM_PORT||6161)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]
