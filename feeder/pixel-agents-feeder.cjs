#!/usr/bin/env node
/*
 * pixel-agents-client.js — pixel-agents CLIENT.
 *
 * Reads the local Claude transcripts (~/.claude/projects/STAR/STAR.jsonl) and
 * STREAMS new lines over a WebSocket connection to the central pixel-agents
 * server (endpoint /feed). NO hook, NO writing to disk.
 *
 * The feed shares the viewer's port, so --server is just the viewer URL with a
 * ws(s):// scheme and a /feed path (e.g. wss://my-host/feed, or :6161 locally).
 *
 * Usage (node feeder/pixel-agents-feeder.cjs ...):
 *   node feeder/pixel-agents-feeder.cjs --server ws://<server>:6161/feed \
 *        --user <name> --token <AUTH-TOKEN> [--root <dir>] [--interval 1000]
 *
 * Env alternatives: PIXEL_SERVER_URL, PIXEL_USER, PIXEL_STREAM_TOKEN,
 *                    PIXEL_PROJECTS_ROOT, PIXEL_FEED_INTERVAL, PIXEL_FEED_MAXAGE
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const SERVER = arg('--server', process.env.PIXEL_SERVER_URL || '');
const USER = arg('--user', process.env.PIXEL_USER || os.hostname()).slice(0, 16);
const TOKEN = arg('--token', process.env.PIXEL_STREAM_TOKEN || '');
const ROOT = arg('--root', process.env.PIXEL_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects'));
const INTERVAL = parseInt(arg('--interval', process.env.PIXEL_FEED_INTERVAL || '1000'), 10);
const MAXAGE = parseInt(arg('--maxage', process.env.PIXEL_FEED_MAXAGE || '600000'), 10);

if (!SERVER || !TOKEN) {
  console.error('[client] ERROR: --server <ws-url> and --token <t> are required (or PIXEL_SERVER_URL/PIXEL_STREAM_TOKEN).');
  process.exit(2);
}
if (!/^[\x21-\x7e]{1,16}$/.test(USER)) {
  console.error(`[client] ERROR: invalid --user "${USER}" (1..16 printable ASCII, no spaces).`);
  process.exit(2);
}
if (typeof WebSocket === 'undefined') {
  console.error('[client] ERROR: Node without global WebSocket (Node >= 21 required).');
  process.exit(1);
}

// Credentials travel in the Sec-WebSocket-Protocol header (base64url), NOT in the
// URL — so the token never lands in access logs / proxy logs / process URLs.
const b64url = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const SUBPROTOCOLS = ['pa1', `u.${b64url(USER)}`, `t.${b64url(TOKEN)}`];

// Per file: { read: bytes already read, leftover: incomplete trailing line }
const state = new Map();
let ws = null;
let timer = null;

function listJsonl() {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ROOT, d.name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) {
        out.push({ project: d.name, session: f.slice(0, -'.jsonl'.length), file: path.join(dir, f) });
      }
    }
  }
  return out;
}

function tick() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  for (const meta of listJsonl()) {
    let stat;
    try { stat = fs.statSync(meta.file); } catch { continue; }

    let st = state.get(meta.file);
    if (!st) {
      // First sighting: send fresh sessions in full (animation context),
      // ignore old ones from end-of-file onward.
      const fresh = now - stat.mtimeMs <= MAXAGE;
      st = { read: fresh ? 0 : stat.size, leftover: '' };
      state.set(meta.file, st);
    }
    if (stat.size < st.read) { st.read = 0; st.leftover = ''; } // truncation/rotation
    if (stat.size === st.read) continue;

    let chunk;
    try {
      const fd = fs.openSync(meta.file, 'r');
      const buf = Buffer.alloc(stat.size - st.read);
      fs.readSync(fd, buf, 0, buf.length, st.read);
      fs.closeSync(fd);
      chunk = buf.toString('utf-8');
    } catch { continue; }
    st.read = stat.size;

    const text = st.leftover + chunk;
    const parts = text.split('\n');
    st.leftover = parts.pop(); // keep the last (possibly incomplete) line
    const lines = parts.filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    try {
      ws.send(JSON.stringify({ s: meta.session, p: meta.project, ls: lines }));
    } catch (e) {
      // Send error -> don't mark bytes as sent, retry next tick
      st.read -= chunk.length;
      st.leftover = '';
    }
  }
}

function connect() {
  console.log(`[client] connecting as "${USER}" -> ${SERVER}`);
  ws = new WebSocket(SERVER, SUBPROTOCOLS);
  ws.onopen = () => {
    console.log('[client] connected. Streaming', ROOT);
    if (timer) clearInterval(timer);
    timer = setInterval(tick, INTERVAL);
  };
  ws.onclose = (e) => {
    console.error(`[client] disconnected (code ${e.code}). Retrying in 3s.`);
    if (timer) { clearInterval(timer); timer = null; }
    setTimeout(connect, 3000);
  };
  ws.onerror = () => { /* onclose follows */ };
}

connect();
