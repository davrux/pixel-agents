import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Resolve @pixel/shared straight to its TypeScript source (outside node_modules)
// so Vite transpiles it and never pulls @colyseus/schema into the browser bundle
// (the client reads state via @colyseus/sdk reflection; schema types are type-only).
const shared = (p: string) => resolve(import.meta.dirname,'../shared/src', p);

// Serve the HMR dev page over HTTPS when a cert exists in the data dir (the same
// one the server uses), so the page origin is https → the client derives wss://
// and matches the TLS Colyseus server. Falls back to HTTP when no cert is present.
function devHttps(): { cert: Buffer; key: Buffer } | undefined {
  // Same default as the server's own dataDir() (server/src/paths.ts is the
  // source of truth): tmp/data in the repo. Duplicated rather than imported
  // because this config belongs to another package — so if that default moves
  // again, it moves in both places or the HMR page silently drops to HTTP.
  const dataDir = process.env.PIXEL_STREAM_DATA_DIR?.trim() || resolve(import.meta.dirname, '..', 'tmp', 'data');
  const cert = process.env.PIXEL_TLS_CERT || resolve(dataDir, 'cert.pem');
  const key = process.env.PIXEL_TLS_KEY || resolve(dataDir, 'key.pem');
  return existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;
}

export default defineConfig({
  resolve: {
    alias: {
      '@pixel/shared/office': shared('office'),
      '@pixel/shared/protocol': shared('protocol.ts'),
      '@pixel/shared/commands': shared('commands.ts'),
      '@pixel/shared/timetracking': shared('timetracking.ts'),
      '@pixel/shared/schema': shared('schema/index.ts'),
      '@pixel/shared': shared('index.ts'),
    },
  },
  server: {
    port: 5173,
    https: devHttps(),
  },
  optimizeDeps: {
    // matrix-js-sdk's rust-crypto wasm loader builds its fetch URL relative to whatever chunk it ends
    // up in. When @matrix-org/matrix-sdk-crypto-wasm is itself prebundled, that URL is computed
    // relative to node_modules/.vite/deps/ — from there the relative `../../../../` segments clamp at
    // the dev-server root and resolve to the SPA fallback (text/html, not application/wasm), so
    // WebAssembly.instantiateStreaming rejects and initRustCrypto() throws (both the IndexedDB and the
    // memory-only fallback load the same wasm, so both throw — verified against a live dev server
    // returning HTTP 200 text/html for that URL). Excluding it from prebundling keeps the URL resolving
    // against its real node_modules location, which Vite's dev server serves with the correct MIME.
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
  build: {
    rollupOptions: {
      // Multi-page: the 2D game (index.html) and the standalone ad-hoc
      // meeting-room join page. The admin panel is an in-game overlay
      // (client/src/admin/main.ts, dynamically imported), not its own page.
      input: {
        main: resolve(import.meta.dirname,'index.html'),
        meet: resolve(import.meta.dirname,'meet.html'),
      },
    },
  },
});
