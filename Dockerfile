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

# ── Build: workspace deps + the Phaser client (client/dist) ─
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
# pnpm-workspace.yaml's allowBuilds gates dependency build scripts explicitly.
RUN pnpm install --frozen-lockfile
# Vendor the self-hosted EmulatorJS engine (free engine code, NOT game content —
# like js-dos, it belongs in the image; needs network egress at build), then build
# the client. NO game bundles/ROMs are baked in: all arcade *content* (shareware +
# licensed WADs + emulator ROMs) is provided at RUNTIME from ARCADE_CONTENT_DIR (a
# bind-mount), so the image stays free of copyrighted bytes and safe to publish.
# Build the content once with `pnpm build:arcade` and mount it (see docs/dev-notes.md
# + tmp/docker-compose.yml).
# vendor:mediapipe joins it for the same reason: the conference background filters
# (blur / virtual background) run a self-hosted MediaPipe segmenter — free engine
# code + model, no runtime CDN. Skipping it only costs the Filters button.
RUN pnpm run vendor:emulatorjs && pnpm run vendor:mediapipe && pnpm run build

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

# /health on the viewer port (no auth) — used as the container healthcheck. The
# server serves HTTPS when a cert is present (self-signed in first-step prod), so
# try https (accepting the self-signed cert) first, then fall back to http.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "const p=process.env.PIXEL_STREAM_PORT||6161;const g=(m)=>new Promise(r=>{const q=require('node:'+m).get(m+'://127.0.0.1:'+p+'/health',{rejectUnauthorized:false},x=>r(x.statusCode===200));q.on('error',()=>r(false));q.setTimeout(4000,()=>{q.destroy();r(false)})});(async()=>process.exit((await g('https'))||(await g('http'))?0:1))()"

CMD ["pnpm", "start"]
