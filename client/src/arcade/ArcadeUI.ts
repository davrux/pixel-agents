/**
 * The arcade cabinet overlay — a centered, pixel-menu-styled window that hosts a
 * js-dos player running a DOS game. Shared by both clients (2D Pixels + 3D Voxel):
 * a machine's "use" action calls `open(game)`; closing stops the emulator.
 *
 * The window can go true fullscreen. Mouse capture (pointer lock) is enabled so
 * Doom's mouselook works; Escape releases the mouse (browser), the ✕ / Leave
 * button closes the cabinet. Multiplayer is wired via the optional net params on
 * `open()` (host runs an IPX server; joiners connect to the host's peer id).
 */
import { loadJsDos, pruneCorruptBundleCache, JSDOS_PATH_PREFIX, type DosInstance, type DosNetConfig, type DosCommandInterface, type InitFsEntry } from './jsdos.js';
import { storeZip } from './zip.js';
import { parseArcadeCatalog, type ArcadeGame } from '@pixel/shared';
import { openPaDialog, paDialogOpen, closePaDialog } from '../ui/paDialog.js';
import { isDesktop, desktop } from '../desktop/bridge.js';
import { serverHttpOrigin } from '../net/room.js';

/** Resolve a `/arcade/content/...` URL against the connected SERVER origin. Content
 *  lives only on the server (not the page origin): on the Vite dev server the page is
 *  :5173 but content is on :2567, and the desktop app:// shell serves no content at
 *  all — so a root-relative URL would 404 / "network error". Engine assets
 *  (`/emulatorjs/`, `/jsdos/`) are NOT routed here: they're shipped in the client
 *  build / public dir and stay same-origin. */
function resolveArcadeUrl(url: string): string {
  return url.startsWith('/') ? `${serverHttpOrigin()}${url}` : url;
}

/** Read at most `n` leading bytes of a response body, then cancel the stream. */
async function readLeadingBytes(res: Response, n: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer()).slice(0, n);
  const out: number[] = [];
  while (out.length < n) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const b of value) {
      out.push(b);
      if (out.length >= n) break;
    }
  }
  void reader.cancel().catch(() => undefined);
  return new Uint8Array(out);
}

export interface ArcadeOpenOpts {
  /** Multiplayer: start as the IPX host. */
  startIpxServer?: boolean;
  /** Multiplayer: join the host at this peer id / alias. */
  connectIpxAddress?: string;
  /** Multiplayer host: advertise this match alias once js-dos' net layer is up
   *  (js-dos does NOT auto-register, so joiners' connectIpxAddress can't resolve
   *  without it). Host only — never combine with connectIpxAddress. */
  registerAlias?: string;
  net?: DosNetConfig;
  /** NET.BAT contents to re-assert LAST (after the restored save) for a networked
   *  launch. For multiplayer-capable games open() also defaults this to the
   *  single-player command when absent, so a stale IPXSETUP NET.BAT persisted into
   *  a prior match's savegame can never force IPX on a later launch. */
  netBat?: string;
  /** Extra FS seeds layered on the bundle at boot. */
  initFs?: InitFsEntry[];
  /** Called when the player leaves / closes the cabinet. */
  onClose?: () => void;
}

/** Multiplayer lobby transport, injected per client (wired to its Colyseus room).
 *  ArcadeUI drives the lobby UI + launch; the host forwards server messages in. */
export interface ArcadeLobbyHooks {
  /** Send a lobby command to the room (arcadeLobbyJoin/Leave/Mode/Start). */
  send(type: string, payload: Record<string, unknown>): void;
}

/** Server-backed savegame transport, injected per client (each wires it to its room).
 *  `load` returns the stored js-dos changes bundle for a game, `save` persists it. */
export interface ArcadeSaveHooks {
  load(gameId: string): Promise<Uint8Array | null>;
  save(gameId: string, data: Uint8Array): Promise<void>;
  /** Delete the player's stored save for a game (reset to the bundle's defaults). */
  reset(gameId: string): void;
}

export interface ArcadeMenuOpts {
  /** Called when the arcade session fully ends (picker cancelled or game closed) —
   *  the host restores its input (re-lock the pointer / re-enable keyboard). */
  onClose?: () => void;
  /** The cabinet's tile key "col,row" — needed to broker a multiplayer match. */
  cabinet?: string;
}

const CSS = `
  #pa-arc{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:130;display:none;
    width:min(94vw,64rem);height:min(90vh,44rem);flex-direction:column;background:#0f1220;border:2px solid #05060b;
    border-radius:0.6rem;color:#e9ecf7;font-family:'FS Pixel Sans',ui-monospace,monospace;overflow:hidden;
    box-shadow:inset 0 2px 0 #232a44,inset 0 -3px 0 #080a14,0 12px 28px rgba(0,0,0,.55);}
  #pa-arc:fullscreen{width:100%;height:100%;left:0;top:0;transform:none;border:0;border-radius:0;max-width:none;}
  #pa-arc .pa-arc-head{display:flex;align-items:center;gap:0.6rem;padding:0.6rem 0.85rem;background:#0f1220;
    border-bottom:2px solid #05060b;box-shadow:inset 0 -1px 0 #1b2138;}
  #pa-arc .pa-arc-head .title{font-size:1.2rem;color:#eef1fb;font-weight:600;letter-spacing:.3px;}
  #pa-arc .pa-arc-head .sub{color:#6f7590;font-size:0.85rem;}
  #pa-arc .pa-arc-head .status{margin-left:auto;font-size:0.85rem;color:#7fd08a;}
  #pa-arc .pa-arc-head .status.err{color:#f2a1a1;}
  /* The js-dos player mounts here and fills the area (black letterbox around it). */
  #pa-arc .pa-arc-stage{flex:1;min-height:0;position:relative;background:#000;}
  #pa-arc .pa-arc-dos{position:absolute;inset:0;}
  #pa-arc .pa-arc-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    color:#9aa3b2;font-size:1rem;text-align:center;padding:1rem;}
  #pa-arc .pa-arc-bar{display:flex;align-items:center;justify-content:center;gap:0.5rem;flex-wrap:wrap;
    padding:0.55rem;background:#0f1220;border-top:2px solid #05060b;box-shadow:inset 0 1px 0 #1b2138;}
  #pa-arc .pa-arc-bar .hint{color:#6f7590;font-size:0.82rem;margin-right:auto;padding-left:0.35rem;}
  #pa-arc .pa-arc-bar button{cursor:pointer;background:#141826;border:2px solid #05060b;color:#e9ecf7;
    border-radius:0.45rem;font:0.95rem 'FS Pixel Sans',monospace;padding:0.5rem 0.7rem;
    box-shadow:inset 0 2px 0 #2b3252,inset 0 -3px 0 #090b16;}
  #pa-arc .pa-arc-bar button:hover{background:#1a2032;}
  #pa-arc .pa-arc-bar button.leave{background:#7c2634;border-color:#05060b;color:#f1d0d6;
    box-shadow:inset 0 2px 0 #b34a5a,inset 0 -3px 0 #45111a;}
`;

export class ArcadeUI {
  private static _instance: ArcadeUI | null = null;
  /** Single shared cabinet overlay (both clients use one). */
  static get(): ArcadeUI {
    return (ArcadeUI._instance ??= new ArcadeUI());
  }

  private readonly root: HTMLDivElement;
  private readonly stageEl: HTMLDivElement;
  private readonly dosEl: HTMLDivElement;
  private readonly msgEl: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly subEl: HTMLSpanElement;
  private readonly statusEl: HTMLSpanElement;
  private dos: DosInstance | null = null;
  private ci: DosCommandInterface | null = null; // set on 'ci-ready' — used to persist saves
  private game: ArcadeGame | null = null; // the game currently booted (for save keying)
  private saveHooks: ArcadeSaveHooks | null = null;
  private lobbyHooks: ArcadeLobbyHooks | null = null;
  private onClose: (() => void) | null = null;
  private opening = false;
  // Active multiplayer lobby (while the lobby modal is open, before launch).
  private lobby: { game: ArcadeGame; cabinet: string; onClose?: () => void } | null = null;
  // Cabinet of a launched MP match — so closing the cabinet tells the server we
  // left (the server keeps a `started` match until its members leave; without this
  // a stale match blocks the next MP start with a silent "connecting to lobby").
  private mpCabinet: string | null = null;
  // The launched match's alias + whether we host it — so close() can cleanly tear
  // down js-dos' HumbleNet layer (unregister the alias, shut the net down). Without
  // this, the dead session lingers on net.dos.zone and every later match hangs at
  // "looking up address".
  private mpAlias: string | null = null;
  private mpHost = false;
  // Blob URL of a bundle fetched with credentials (desktop path, see open()) — held
  // so close() can revoke it.
  private bundleObjectUrl: string | null = null;
  // Cached runtime catalog (fetched from /arcade/catalog).
  private catalog: ArcadeGame[] | null = null;

  /** Wire server-backed savegames (called once per client with its room transport). */
  setSaveHooks(hooks: ArcadeSaveHooks | null): void {
    this.saveHooks = hooks;
  }

  /** Wire the multiplayer lobby transport (called once per client with its room). */
  setLobbyHooks(hooks: ArcadeLobbyHooks | null): void {
    this.lobbyHooks = hooks;
  }

  private constructor() {
    if (!document.getElementById('pa-arc-style')) {
      const s = document.createElement('style');
      s.id = 'pa-arc-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const root = document.createElement('div');
    root.id = 'pa-arc';
    root.className = 'pa-ui';
    root.innerHTML = `
      <div class="pa-arc-head">
        <span class="title"></span><span class="sub"></span><span class="status"></span>
      </div>
      <div class="pa-arc-stage">
        <div class="pa-arc-dos"></div>
        <div class="pa-arc-msg"></div>
      </div>
      <div class="pa-arc-bar">
        <span class="hint">Mouse look · Esc releases the mouse</span>
        <button data-full title="Fullscreen">⛶ Fullscreen</button>
        <button data-leave class="leave">Leave</button>
      </div>`;
    (document.getElementById('game') ?? document.body).appendChild(root);
    this.root = root;
    this.stageEl = root.querySelector('.pa-arc-stage')!;
    this.dosEl = root.querySelector('.pa-arc-dos')!;
    this.msgEl = root.querySelector('.pa-arc-msg')!;
    this.titleEl = root.querySelector('.pa-arc-head .title')!;
    this.subEl = root.querySelector('.pa-arc-head .sub')!;
    this.statusEl = root.querySelector('.pa-arc-head .status')!;
    root.querySelector<HTMLButtonElement>('[data-full]')!.onclick = () => this.toggleFullscreen();
    root.querySelector<HTMLButtonElement>('[data-leave]')!.onclick = () => this.close();
  }

  /** Is a cabinet currently open? (guards world input while playing) */
  get isOpen(): boolean {
    return this.root.style.display === 'flex';
  }

  /** Fetch the runtime game catalog from the server (public metadata endpoint).
   *  Cached after the first success; validated with the shared parser so a bad
   *  entry can't break the launcher. Works on browser (same-origin) + desktop. */
  private async loadCatalog(): Promise<ArcadeGame[]> {
    if (this.catalog) return this.catalog;
    try {
      const res = await fetch(`${serverHttpOrigin()}/arcade/catalog`, { cache: 'no-store' });
      const body = res.ok ? ((await res.json()) as { games?: unknown }) : null;
      this.catalog = parseArcadeCatalog(body?.games);
    } catch {
      this.catalog = [];
    }
    return this.catalog;
  }

  /** Show the game picker (shared pixel-menu look); choosing a title boots it. This
   *  is the entry point both worlds use so the cabinet always offers a title menu.
   *  opts.onClose fires when the session fully ends (picker cancelled or game closed). */
  async openMenu(opts: ArcadeMenuOpts = {}): Promise<void> {
    if (this.isOpen || paDialogOpen()) return;
    const games = await this.loadCatalog();
    if (paDialogOpen() || this.isOpen) return; // a dialog/game opened while we fetched
    const body = document.createElement('div');
    if (!games.length) {
      body.innerHTML =
        '<div style="opacity:.8">No games are installed.<br>' +
        'Add content to the server\'s ARCADE_CONTENT_DIR (see docs/dev-notes.md).</div>';
      openPaDialog({ title: '🕹 Arcade', body, onClose: () => opts.onClose?.(), buttons: [] });
      return;
    }
    let launched = false;
    for (const game of games) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:0.35rem;align-items:stretch;margin:0 0 0.45rem;';
      const btn = document.createElement('button');
      btn.className = 'pa-btn';
      btn.style.cssText = 'flex:1;text-align:left;margin:0;';
      btn.innerHTML =
        `<b>${esc(game.title)}</b><br><span style="opacity:.7;font-size:.85em">` +
        `${esc(game.blurb)}${game.multiplayer ? ` · up to ${game.maxPlayers}P` : ''}</span>`;
      btn.onclick = () => {
        launched = true;
        closePaDialog();
        void this.open(game, { onClose: opts.onClose });
      };
      row.appendChild(btn);
      // Multiplayer (👥): open a lobby at this cabinet (needs the room transport).
      if (game.multiplayer && this.lobbyHooks && opts.cabinet) {
        const cabinet = opts.cabinet;
        const mp = document.createElement('button');
        mp.className = 'pa-btn';
        mp.style.cssText = 'flex:0 0 auto;margin:0;';
        mp.title = `Multiplayer — up to ${game.maxPlayers} players`;
        mp.textContent = '👥';
        mp.onclick = (e) => {
          e.stopPropagation();
          launched = true;
          closePaDialog();
          this.openLobby(game, cabinet, opts.onClose);
        };
        row.appendChild(mp);
      }
      // Delete-save (↺): two-click armed to avoid wiping progress by accident.
      if (this.saveHooks) {
        const hooks = this.saveHooks;
        const rm = document.createElement('button');
        rm.className = 'pa-btn';
        rm.style.cssText = 'flex:0 0 auto;margin:0;';
        rm.title = 'Delete this game’s saved data';
        rm.textContent = '↺';
        let armed = 0;
        rm.onclick = (e) => {
          e.stopPropagation();
          if (!armed) {
            armed = window.setTimeout(() => { armed = 0; rm.textContent = '↺'; rm.style.color = ''; }, 2500);
            rm.textContent = '⚠';
            rm.style.color = '#f0a0a0';
            return;
          }
          window.clearTimeout(armed);
          armed = 0;
          hooks.reset(game.id);
          rm.textContent = '✓';
          rm.style.color = '#7fd08a';
        };
        row.appendChild(rm);
      }
      body.appendChild(row);
    }
    openPaDialog({
      title: '🕹 Arcade',
      body,
      onClose: () => {
        if (!launched) opts.onClose?.(); // cancelled without picking → restore input now
      },
      buttons: [],
    });
  }

  // ── Multiplayer lobby ────────────────────────────────────────────
  private lobbyBody: HTMLDivElement | null = null;

  /** Open a multiplayer lobby at this cabinet for `game` (join or host). */
  private openLobby(game: ArcadeGame, cabinet: string, onClose?: () => void): void {
    if (!this.lobbyHooks || this.isOpen || paDialogOpen()) return;
    this.lobby = { game, cabinet, onClose };
    this.lobbyBody = document.createElement('div');
    this.renderLobby({ connecting: true });
    this.lobbyHooks.send('arcadeLobbyJoin', { game: game.id, cabinet });
    openPaDialog({
      title: `👥 ${game.title} — Multiplayer`,
      body: this.lobbyBody,
      onClose: () => {
        // Left the lobby (unless we launched): tell the server + restore input.
        if (this.lobby) {
          this.lobbyHooks?.send('arcadeLobbyLeave', { cabinet });
          const cb = this.lobby.onClose;
          this.lobby = null;
          cb?.();
        }
      },
      buttons: [],
    });
  }

  /** Host forwards the room's `arcadeLobby` state message here. */
  onLobbyMsg(m: Record<string, unknown>): void {
    if (!this.lobby || m.cabinet !== this.lobby.cabinet) return;
    if (m.closed) { this.lobby = null; closePaDialog(); return; } // host left / dissolved
    if (m.busy) { this.renderLobbyBusy(m.reason === 'running' ? 'running' : 'othergame'); return; }
    this.renderLobby(m);
  }

  /** Host forwards the room's `arcadeLaunch` message here → boot the networked game. */
  onLaunchMsg(m: Record<string, unknown>): void {
    if (!this.lobby || m.cabinet !== this.lobby.cabinet) return;
    const { game, onClose } = this.lobby;
    this.lobby = null;
    this.mpCabinet = typeof m.cabinet === 'string' ? m.cabinet : null;
    this.mpAlias = typeof m.alias === 'string' ? m.alias : null;
    this.mpHost = !!m.host;
    closePaDialog();
    const nodes = Number(m.nodes) || 2;
    // NET.BAT so the bundle's autoexec runs IPXSETUP (→ networked DOOM). Passed via
    // opts.netBat, which open() re-asserts LAST (after the restored save) — a prior
    // networked match persists this NET.BAT into the savegame, so it must always be
    // overridden per-launch or single-player / re-matches keep running IPX.
    const netBat = `@echo off\r\nIPXSETUP -nodes ${nodes}${m.mode === 'dm' ? ' -deathmatch' : ''}\r\n`;
    // NOTE: js-dos uses its own signaling (HumbleNet, default broker net.dos.zone),
    // NOT standard PeerJS — so we can't self-host with the `peer` package.
    // Rendezvous is by alias: the HOST starts the IPX server and must advertise the
    // match alias itself (js-dos does NOT auto-register — see registerHostAlias);
    // JOINERS pass connectIpxAddress=alias, which polls queryAliases until the host
    // has registered. The host must NOT set connectIpxAddress or it would wait on
    // its own (never-registered) alias and hang at "Creating server".
    const isHost = !!m.host;
    const alias = typeof m.alias === 'string' ? m.alias : undefined;
    // TURN/STUN relay for NAT-to-NAT play (server-minted, see arcadeTurn.ts). Absent
    // → js-dos falls back to its built-in public STUN (LAN/same-machine only).
    const iceServers = Array.isArray(m.iceServers) ? (m.iceServers as RTCIceServer[]) : undefined;
    void this.open(game, {
      startIpxServer: isHost,
      connectIpxAddress: isHost ? undefined : alias,
      registerAlias: isHost ? alias : undefined,
      net: iceServers && iceServers.length ? { iceServers: () => iceServers } : undefined,
      netBat,
      onClose,
    });
  }

  /** Host side: once js-dos' HumbleNet layer is up (window.net with a real peerId),
   *  publish our match alias so joiners (connectIpxAddress=alias) can resolve it.
   *  js-dos boots the emulator without ever registering an alias, so we do it.
   *  Called from open() right after this.dos is assigned, so the instance guard is
   *  valid (bails only if the cabinet is closed/reopened while we wait for net). */
  private registerHostAlias(alias: string): void {
    const instance = this.dos;
    // Capture the previous net so we don't register on a stale (already-stopped)
    // window.net from an earlier match — js-dos replaces window.net with a fresh
    // instance once this game's net layer comes up. Registering on the old one
    // leaves joiners of a *second* match stuck at "looking up address".
    const staleNet = (window as unknown as { net?: unknown }).net;
    let tries = 0;
    const tick = (): void => {
      if (this.dos !== instance) return; // cabinet changed → stop
      const net = (window as unknown as { net?: { peerId?: number; registerAlias?: (a: string) => Promise<void> } }).net;
      if (net && net !== staleNet && net.peerId && net.registerAlias) {
        console.log('[arcade] host registering IPX alias', alias, 'peerId', net.peerId);
        void Promise.resolve(net.registerAlias(alias))
          .then(() => console.log('[arcade] IPX alias registered', alias))
          .catch((e) => console.warn('[arcade] IPX alias register failed', alias, e));
        return;
      }
      if (tries++ < 600) window.setTimeout(tick, 100); // wait up to ~60s for net to come up
      else console.warn('[arcade] IPX net never came up — alias not registered', alias);
    };
    window.setTimeout(tick, 200);
  }

  /** Tear down js-dos' HumbleNet layer when the cabinet closes. js-dos never shuts
   *  the net down itself, so its WebSocket to net.dos.zone (and the host's registered
   *  alias) linger — and every later match then hangs at "looking up address".
   *  Unregister our alias (host), shut the net down, and drop window.net so the next
   *  launch builds a fresh one. */
  private teardownNet(): void {
    const w = window as unknown as {
      net?: { unregisterAlias?: (a: string) => void; shutdown?: () => void };
    };
    const net = w.net;
    if (net) {
      try {
        if (this.mpHost && this.mpAlias) net.unregisterAlias?.(this.mpAlias);
        net.shutdown?.();
        console.log('[arcade] IPX net torn down', this.mpAlias ?? '');
      } catch (e) {
        console.warn('[arcade] IPX net teardown failed', e);
      }
      w.net = undefined;
    }
    this.mpAlias = null;
    this.mpHost = false;
  }

  /** This cabinet is occupied by a running match (or a different game) — show a
   *  clear notice with a Close button instead of hanging on "connecting". */
  private renderLobbyBusy(reason: 'running' | 'othergame'): void {
    const body = this.lobbyBody;
    if (!body) return;
    const text =
      reason === 'running'
        ? 'A match is already running at this cabinet.\nWait for it to finish, then try again.'
        : 'This cabinet is busy with another game.';
    body.innerHTML = `<div style="opacity:.85;white-space:pre-line;margin:0 0 .7rem">${esc(text)}</div>`;
    const close = document.createElement('button');
    close.className = 'pa-btn';
    close.textContent = 'Close';
    close.style.width = '100%';
    close.onclick = () => closePaDialog();
    body.appendChild(close);
  }

  private renderLobby(m: Record<string, unknown>): void {
    const body = this.lobbyBody;
    if (!body) return;
    if (m.connecting) { body.innerHTML = '<div style="opacity:.8">Connecting to the lobby…</div>'; return; }
    const members = Array.isArray(m.members) ? (m.members as string[]) : [];
    const max = Number(m.max) || 4;
    const youAreHost = !!m.youAreHost;
    const mode = m.mode === 'coop' ? 'coop' : 'dm';
    const cabinet = String(m.cabinet ?? '');
    body.innerHTML =
      `<div style="margin:0 0 .5rem">Players (${members.length}/${max}):</div>` +
      `<div style="margin:0 0 .7rem">${members.map((n) => `• ${esc(n)}`).join('<br>') || '—'}</div>` +
      (youAreHost
        ? `<div class="row" style="display:flex;gap:.4rem;margin:0 0 .6rem">
             <button class="pa-btn" data-mode="dm" ${mode === 'dm' ? 'style="border-color:#5a92d6"' : ''}>Deathmatch</button>
             <button class="pa-btn" data-mode="coop" ${mode === 'coop' ? 'style="border-color:#56b566"' : ''}>Co-op</button>
           </div>`
        : `<div style="opacity:.8;margin:0 0 .6rem">Mode: ${mode === 'dm' ? 'Deathmatch' : 'Co-op'} — waiting for the host to start…</div>`);
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:.4rem';
    if (youAreHost) {
      const start = document.createElement('button');
      start.className = 'pa-btn';
      start.textContent = members.length >= 2 ? `Start (${members.length}P)` : 'Waiting for players…';
      start.style.flex = '1';
      (start as HTMLButtonElement).disabled = members.length < 2;
      start.onclick = () => this.lobbyHooks?.send('arcadeLobbyStart', { cabinet });
      controls.appendChild(start);
    }
    body.appendChild(controls);
    body.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
      b.onclick = () => this.lobbyHooks?.send('arcadeLobbyMode', { cabinet, mode: b.dataset.mode });
    });
  }

  /** Open the cabinet and boot the game. Safe to call again after close(). */
  async open(game: ArcadeGame, opts: ArcadeOpenOpts = {}): Promise<void> {
    if (this.opening) return;
    this.opening = true;
    this.game = game;
    this.ci = null;
    this.onClose = opts.onClose ?? null;
    this.titleEl.textContent = `🕹 ${game.title}`;
    this.subEl.textContent = `· ${game.blurb}`;
    this.setStatus('… loading', false);
    this.msgEl.textContent = 'Loading emulator…';
    this.msgEl.style.display = 'flex';
    this.root.style.display = 'flex';
    try {
      // The game file lives in the server's content dir, served at
      // /arcade/content/<file>; ?v=<version> busts the HTTP/OPFS cache on a swap.
      const v = game.version ? `?v=${encodeURIComponent(game.version)}` : '';
      let bundleUrl = resolveArcadeUrl(`/arcade/content/${encodeURIComponent(game.file)}${v}`);
      if (!this.isOpen) return;
      const expectZip = game.emulator === 'jsdos'; // js-dos bundles are ZIPs (PK magic); ROMs aren't.
      if (isDesktop()) {
        // The desktop renderer is a cross-origin, cookie-less app:// shell, so the
        // emulator's own fetch can't carry the (auth-gated) session. Fetch the bytes
        // here with the desktop bearer and hand the emulator a blob: URL. Bytes stay
        // in memory, so no network re-fetch. (Browser stays same-origin below.)
        const token = await desktop().getToken().catch(() => null);
        const res = await fetch(bundleUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        }).catch(() => null);
        if (!this.isOpen) return;
        const buf = res && res.ok ? await res.arrayBuffer().catch(() => null) : null;
        const okZip = !expectZip || (!!buf && buf.byteLength >= 2 && new Uint8Array(buf, 0, 2)[0] === 0x50 && new Uint8Array(buf, 0, 2)[1] === 0x4b);
        if (!buf || !okZip) {
          const unauth = res?.status === 401;
          this.setStatus(unauth ? 'sign in required' : 'not installed', true);
          this.msgEl.textContent = unauth
            ? `“${game.title}” needs you to be signed in on this server.`
            : `“${game.title}” isn't installed on the server.`;
          return;
        }
        this.bundleObjectUrl = URL.createObjectURL(new Blob([buf]));
        bundleUrl = this.bundleObjectUrl;
      } else {
        // Browser: ranged GET probe. A stale auth gate can 200 a login page; js-dos
        // would cache those bytes in OPFS and crash ("Not a zip archive"), so for DOS
        // bundles we verify the PK magic. Same-origin → the cookie authorises the file.
        const probe = await fetch(bundleUrl, { headers: { Range: 'bytes=0-1' }, cache: 'no-store' }).catch(() => null);
        const magic = probe && probe.ok ? await readLeadingBytes(probe, 2).catch(() => null) : null;
        if (!this.isOpen) return;
        if (!probe || !probe.ok) {
          this.setStatus('not installed', true);
          this.msgEl.textContent = `“${game.title}” isn't installed on the server.`;
          return;
        }
        if (expectZip && (!magic || magic.length < 2 || magic[0] !== 0x50 || magic[1] !== 0x4b)) {
          this.setStatus('server outdated', true);
          this.msgEl.textContent = `“${game.title}” can't start: the server returned something that isn't a game bundle.`;
          return;
        }
      }

      // EmulatorJS (libretro: NES/SNES/GB/arcade/…) — boot the ROM and we're done
      // (no DOS FS/savegame/IPX plumbing). Loaded lazily so the engine only downloads
      // when a non-DOS game is actually played.
      if (game.emulator === 'emulatorjs') {
        this.dosEl.innerHTML = '';
        const { loadEmulatorJs } = await import('./emulatorjs.js');
        if (!this.isOpen) return;
        this.dos = await loadEmulatorJs(this.dosEl, {
          core: game.core || 'nes',
          gameUrl: bundleUrl,
          gameName: game.title,
          onStart: () => { this.setStatus('● running', false); this.msgEl.style.display = 'none'; },
        });
        return;
      }

      // js-dos (DOS). A previous launch may have cached a bad response in js-dos' OPFS
      // bundle cache — it replays before any refetch, so scrub it now.
      await pruneCorruptBundleCache();
      if (!this.isOpen) return;
      // Seed the FS via initFs: caller-supplied files first (e.g. NET.BAT for a
      // multiplayer launch), then the player's server-stored savegame — both
      // overlay the self-contained engine+WAD bundle.
      const initFs: InitFsEntry[] = [...(opts.initFs ?? [])];
      if (this.saveHooks) {
        const saved = await this.saveHooks.load(game.id).catch(() => null);
        if (!this.isOpen) return;
        if (saved && saved.length) initFs.push(saved);
      }
      // Re-assert NET.BAT LAST (overrides bundle AND the restored save). A networked
      // match persists NET.BAT=IPXSETUP into the save, so without this a later
      // single-player or re-match keeps running IPX. MP → the IPXSETUP command;
      // otherwise a multiplayer-capable game resets to single-player DOOM.EXE.
      const netBat = opts.netBat ?? (game.multiplayer ? '@echo off\r\nDOOM.EXE\r\n' : null);
      if (netBat) initFs.push(storeZip([{ name: 'NET.BAT', data: new TextEncoder().encode(netBat) }]));
      const Dos = await loadJsDos();
      // If the user bailed while js-dos was loading, don't boot.
      if (!this.isOpen) return;
      this.dosEl.innerHTML = ''; // fresh mount (any prior game's canvas was left hidden)
      this.dos = Dos(this.dosEl, {
        url: bundleUrl,
        pathPrefix: JSDOS_PATH_PREFIX,
        backend: 'dosbox',
        initFs: initFs.length ? initFs : undefined,
        autoStart: true,
        kiosk: true,
        mouseCapture: true,
        startIpxServer: opts.startIpxServer,
        connectIpxAddress: opts.connectIpxAddress,
        net: opts.net,
        onEvent: (event, ci) => this.onDosEvent(String(event), ci),
      });
      // Host: now that this.dos points at the live instance, advertise the alias.
      if (opts.registerAlias) this.registerHostAlias(opts.registerAlias);
    } catch (err) {
      this.setStatus('failed to load', true);
      this.msgEl.textContent = `Could not start the game.\n${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.opening = false;
    }
  }

  private onDosEvent(event: string, ci?: DosCommandInterface): void {
    if (event === 'ci-ready') {
      if (ci) this.ci = ci; // keep the interface so we can persist the FS on close
      this.setStatus('● running', false);
      this.msgEl.style.display = 'none';
    } else if (event === 'emu-ready') {
      this.setStatus('… starting', false);
    }
  }

  private setStatus(text: string, err: boolean): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('err', err);
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void this.root.requestFullscreen?.().catch(() => undefined);
  }

  /** Persist the savegame, stop the emulator and hide the cabinet. */
  close(): void {
    if (document.fullscreenElement === this.root) void document.exitFullscreen().catch(() => undefined);
    const inst = this.dos;
    const ci = this.ci;
    const game = this.game;
    const hooks = this.saveHooks;
    this.dos = null;
    this.ci = null;
    this.game = null;
    // Leave a launched MP match so the server frees the (started) match for reuse.
    if (this.mpCabinet) {
      this.lobbyHooks?.send('arcadeLobbyLeave', { cabinet: this.mpCabinet });
      this.mpCabinet = null;
    }
    this.teardownNet();
    // Free a credential-fetched bundle blob (desktop path).
    if (this.bundleObjectUrl) {
      URL.revokeObjectURL(this.bundleObjectUrl);
      this.bundleObjectUrl = null;
    }
    // Hide immediately for responsiveness; snapshot the save then tear down the worker.
    this.msgEl.style.display = 'none';
    this.root.style.display = 'none';
    void this.persistThenStop(inst, ci, game, hooks);
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  /** Snapshot changed files (savegames) to the server, THEN stop the emulator —
   *  persist() needs the worker alive, so it must run before stop(). Best-effort:
   *  a failed save never blocks teardown. */
  private async persistThenStop(
    inst: DosInstance | null,
    ci: DosCommandInterface | null,
    game: ArcadeGame | null,
    hooks: ArcadeSaveHooks | null,
  ): Promise<void> {
    try {
      if (ci && game && hooks) {
        const changes = await ci.persist(true);
        if (changes && changes.length) await hooks.save(game.id, changes);
      }
    } catch {
      /* ignore — a failed save shouldn't wedge the cabinet */
    } finally {
      if (inst) await inst.stop().catch(() => undefined);
    }
  }
}

/** Escape text for safe innerHTML (dynamic WAD titles come from admin input). */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
