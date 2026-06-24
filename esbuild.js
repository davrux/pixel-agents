const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');

/** Version read from package.json at build time, inlined via esbuild `define`. */
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'),
).version;
const versionDefine = {
  'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(pkgVersion),
};

/** Copy webview-ui/public/assets -> dist/assets (sprites, tiles, default layout). */
function copyAssets() {
  const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
  const dstDir = path.join(__dirname, 'dist', 'assets');
  if (!fs.existsSync(srcDir)) {
    console.log('ℹ️  assets/ folder not found (optional)');
    return;
  }
  if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true });
  console.log('✓ Copied assets/ → dist/assets/');
}

/** Bundle the stream server entry point to dist/stream.js. */
async function buildServer() {
  await esbuild.build({
    entryPoints: ['server/src/streamServer.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/stream.js',
    external: ['fastify', '@fastify/websocket', '@fastify/static', '@fastify/cors'],
    define: versionDefine,
    logLevel: 'silent',
  });
  console.log('✓ Built server → dist/stream.js');
}

async function main() {
  copyAssets();
  await buildServer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
