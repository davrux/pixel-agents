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
import { loadJsDos, JSDOS_PATH_PREFIX, type DosInstance, type DosNetConfig, type DosCommandInterface, type InitFsEntry } from './jsdos.js';
import { ARCADE_GAMES, ARCADE_GAME_LIST, type ArcadeGame } from '@pixel/shared';
import { openPaDialog, paDialogOpen, closePaDialog } from '../ui/paDialog.js';
import { listWads, fetchWadByUrl, wadUrl, uploadWad } from './wadClient.js';
import { isDesktop } from '../desktop/bridge.js';
import { serverHttpOrigin } from '../net/room.js';

/** Site-root-relative bundle/manifest URLs must resolve against the connected
 *  server in the desktop app: the app:// bundle doesn't ship the gitignored
 *  ~80 MB game bundles — the server builds and serves them (see .dockerignore).
 *  Emulator assets (JSDOS_BASE) stay same-origin: js-dos blob-Workers them. */
function resolveArcadeUrl(url: string): string {
  return isDesktop() && url.startsWith('/') ? `${serverHttpOrigin()}${url}` : url;
}

export interface ArcadeOpenOpts {
  /** Multiplayer: start as the IPX host. */
  startIpxServer?: boolean;
  /** Multiplayer: join the host at this peer id / alias. */
  connectIpxAddress?: string;
  net?: DosNetConfig;
  /** Called when the player leaves / closes the cabinet. */
  onClose?: () => void;
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
  /** Show the admin-only "Upload WAD" control (host passes its known admin flag). */
  canUpload?: boolean;
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
  private onClose: (() => void) | null = null;
  private opening = false;

  /** Wire server-backed savegames (called once per client with its room transport). */
  setSaveHooks(hooks: ArcadeSaveHooks | null): void {
    this.saveHooks = hooks;
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

  /** Show the game picker (shared pixel-menu look); choosing a title boots it. This
   *  is the entry point both worlds use so the cabinet always offers a title menu.
   *  opts.onClose fires when the session fully ends (picker cancelled or game closed). */
  async openMenu(opts: ArcadeMenuOpts = {}): Promise<void> {
    if (this.isOpen || paDialogOpen()) return;
    // Bundled titles + any admin-uploaded WADs (server-wide "bring your own WAD"),
    // which play on the vanilla DOOM.EXE engine bundle with the WAD injected at boot.
    const uploaded = await listWads();
    if (this.isOpen || paDialogOpen()) return;
    const games: ArcadeGame[] = [
      ...ARCADE_GAME_LIST,
      ...uploaded.map(
        (w): ArcadeGame => ({
          id: `wad:${w.name}`,
          title: w.title,
          blurb: `your WAD · ${w.iwad}`,
          bundleUrl: ARCADE_GAMES.doom.bundleUrl, // vanilla DOOM.EXE carrier
          multiplayer: false,
          maxPlayers: 1,
          license: 'user-provided (server operator owns the copy)',
          iwadUrl: wadUrl(w.name),
          iwadName: w.iwad,
        }),
      ),
    ];
    const body = document.createElement('div');
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
    if (opts.canUpload) {
      const up = document.createElement('button');
      up.className = 'pa-btn';
      up.style.cssText = 'display:block;width:100%;text-align:left;margin:0.3rem 0 0;opacity:.85;';
      up.textContent = '⬆ Upload WAD (admin)';
      up.onclick = () => {
        launched = true; // reopening the menu ourselves; don't let this close restore input
        closePaDialog();
        this.promptUploadWad(opts);
      };
      body.appendChild(up);
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

  /** Admin-only: upload a WAD you own; it becomes a server-wide title. The server
   *  enforces admin + validates the file. On success the arcade closes (input is
   *  restored); reopen the cabinet to see + play the new title. */
  private promptUploadWad(menuOpts: ArcadeMenuOpts): void {
    const body = document.createElement('div');
    body.innerHTML =
      '<div class="fld"><label>Title</label><input class="pa-input" data-f="title" maxlength="48" placeholder="e.g. DOOM (full)"></div>' +
      '<div class="fld"><label>Id (a-z, 0-9, -)</label><input class="pa-input" data-f="name" maxlength="32" placeholder="doom-full"></div>' +
      '<div class="fld"><label>IWAD filename</label><input class="pa-input" data-f="iwad" maxlength="20" value="DOOM.WAD"></div>' +
      '<div class="fld"><label>WAD file (your own copy)</label><input type="file" data-f="file" accept=".wad"></div>' +
      '<div data-f="status" style="color:#9aa3b2;font-size:.85rem;min-height:1.1em;"></div>';
    const q = <T extends HTMLElement>(f: string): T => body.querySelector<T>(`[data-f="${f}"]`)!;
    const status = q<HTMLDivElement>('status');
    openPaDialog({
      title: '⬆ Upload WAD',
      body,
      onCancel: () => menuOpts.onClose?.(), // closing the form ends the session → restore input
      buttons: [
        {
          label: 'Upload',
          kind: 'green',
          onClick: () => {
            const name = q<HTMLInputElement>('name').value.trim().toLowerCase();
            const title = q<HTMLInputElement>('title').value.trim();
            const iwad = q<HTMLInputElement>('iwad').value.trim() || 'DOOM.WAD';
            const file = q<HTMLInputElement>('file').files?.[0];
            if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
              status.textContent = 'Id must be a-z, 0-9, dashes (start alphanumeric).';
              return false;
            }
            if (!file) {
              status.textContent = 'Choose a .wad file.';
              return false;
            }
            status.textContent = 'Uploading…';
            void (async () => {
              const buf = new Uint8Array(await file.arrayBuffer());
              const res = await uploadWad(name, title || name, iwad, buf);
              if (res.ok) {
                status.textContent = 'Uploaded ✓ — reopen the cabinet to play it.';
                closePaDialog(); // fires onCancel → restores host input
              } else {
                status.textContent = `Upload failed: ${res.error}`; // stay open to retry
              }
            })();
            return false; // keep the dialog open until the async upload resolves
          },
        },
      ],
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
      // Resolve a content-versioned URL from the bundles manifest so a rebuilt bundle
      // never serves stale from an HTTP cache (?v=<hash> changes when content changes).
      const baseUrl = resolveArcadeUrl(game.bundleUrl);
      let bundleUrl = baseUrl;
      try {
        const manUrl = baseUrl.replace(/[^/]+$/, 'manifest.json');
        const mres = await fetch(manUrl, { cache: 'no-store' });
        if (mres.ok) {
          const man = (await mres.json()) as Record<string, string>;
          if (man?.[game.id]) bundleUrl = `${baseUrl}?v=${man[game.id]}`;
        }
      } catch {
        /* no manifest → use the plain url */
      }
      if (!this.isOpen) return;
      // Fail cleanly when a game's bundle isn't installed yet (e.g. the Doom 2 /
      // Deathmatch Freedoom bundles before they're built) — no raw 404.
      const head = await fetch(bundleUrl, { method: 'HEAD' }).catch(() => null);
      if (!this.isOpen) return;
      if (!head || !head.ok) {
        this.setStatus('not installed', true);
        this.msgEl.textContent = `“${game.title}” isn't installed yet.\nBuild its bundle with scripts/build-arcade-bundles.mjs.`;
        return;
      }
      // Seed the FS via initFs: an uploaded IWAD (bring-your-own-WAD) first, then the
      // player's server-stored savegame — both overlay the engine bundle.
      const initFs: InitFsEntry[] = [];
      if (game.iwadUrl) {
        const wad = await fetchWadByUrl(game.iwadUrl).catch(() => null);
        if (!this.isOpen) return;
        if (wad && wad.length) initFs.push({ path: (game.iwadName || 'DOOM.WAD').toUpperCase(), contents: wad });
      }
      if (this.saveHooks) {
        const saved = await this.saveHooks.load(game.id).catch(() => null);
        if (!this.isOpen) return;
        if (saved && saved.length) initFs.push(saved);
      }
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
