import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Resolve @pixel/shared straight to its TypeScript source (outside node_modules)
// so Vite transpiles it and never pulls @colyseus/schema into the browser bundle
// (the client reads state via colyseus.js reflection; schema types are type-only).
const shared = (p: string) => resolve(__dirname, '../shared/src', p);

export default defineConfig({
  resolve: {
    alias: {
      '@pixel/shared/office': shared('office'),
      '@pixel/shared/worldConfig': shared('worldConfig.ts'),
      '@pixel/shared/protocol': shared('protocol.ts'),
      '@pixel/shared/schema': shared('schema/index.ts'),
      '@pixel/shared': shared('index.ts'),
    },
  },
  server: {
    port: 5173,
  },
});
