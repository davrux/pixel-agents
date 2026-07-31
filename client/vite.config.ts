import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// Resolve @pixel/shared straight to its TypeScript source (outside node_modules)
// so Vite transpiles it and never pulls @colyseus/schema into the browser bundle
// (the client reads state via colyseus.js reflection; schema types are type-only).
const shared = (p: string) => resolve(__dirname, '../shared/src', p);

// Serve the HMR dev page over HTTPS when a cert exists in the data dir (the same
// one the server uses), so the page origin is https → the client derives wss://
// and matches the TLS Colyseus server. Falls back to HTTP when no cert is present.
function devHttps(): { cert: Buffer; key: Buffer } | undefined {
  const dataDir = process.env.PIXEL_STREAM_DATA_DIR?.trim() || resolve(homedir(), '.pixel-agents2');
  const cert = process.env.PIXEL_TLS_CERT || resolve(dataDir, 'cert.pem');
  const key = process.env.PIXEL_TLS_KEY || resolve(dataDir, 'key.pem');
  return existsSync(cert) && existsSync(key) ? { cert: readFileSync(cert), key: readFileSync(key) } : undefined;
}

export default defineConfig({
  resolve: {
    alias: {
      '@pixel/shared/office': shared('office'),
      '@pixel/shared/worldConfig': shared('worldConfig.ts'),
      '@pixel/shared/protocol': shared('protocol.ts'),
      '@pixel/shared/commands': shared('commands.ts'),
      '@pixel/shared/schema': shared('schema/index.ts'),
      '@pixel/shared': shared('index.ts'),
    },
  },
  server: {
    port: 5173,
    https: devHttps(),
  },
  build: {
    rollupOptions: {
      // Multi-page: the 2D game (index.html), the 3D voxel spike, the admin
      // panel, and the standalone ad-hoc meeting-room join page.
      input: {
        main: resolve(__dirname, 'index.html'),
        voxel: resolve(__dirname, 'voxel.html'),
        admin: resolve(__dirname, 'admin.html'),
        meet: resolve(__dirname, 'meet.html'),
      },
    },
  },
});
