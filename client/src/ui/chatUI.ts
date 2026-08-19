/**
 * Shared chat UI. Owns the DOM panel (log + input + resize + hide/open + idle
 * fade + ↑/↓ history), parses slash commands against the shared registry
 * (`/help` local, others forwarded), and renders chat/system lines. Everything
 * host-specific — how messages are sent, admin status, chat bubbles over
 * avatars, the focus guard — comes in through `ChatHooks`.
 */
import { findCommand, mayRunCommand, commandsForGroup, type CommandSpec } from '@pixel/shared/commands';

import { hudButton } from './hudBar.js';

export interface ChatHooks {
  sendChat: (text: string) => void;
  sendCommand: (name: string, args: string) => void;
  isAdmin: () => boolean;
  /** May Enter focus the chat right now? (host guard: not editing / no menu open) */
  canFocus?: () => boolean;
  /** Handle a client-only slash command. Return true if handled here. */
  clientCommand?: (name: string, args: string, sys: (t: string) => void) => boolean;
  /** Host-only commands, merged into /help + TAB autocomplete and handled via
   *  clientCommand. Kept out of the shared registry so they don't appear
   *  everywhere this UI is used. */
  extraCommands?: CommandSpec[];
  onFocus?: () => void; // e.g. release pointer lock
  onBlur?: () => void;
  /** The panel just opened — the host closes whatever else owns the corner
   *  (see OfficeScene: chat and the online list are mutually exclusive). */
  onOpen?: () => void;
}

export class ChatUI {
  private readonly box: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly openBtn: HTMLButtonElement;
  private readonly history: string[] = [];
  private histIdx = -1;
  private draft = '';
  private activeUntil = 0;
  private faded = false;
  private readonly fadeTimer: ReturnType<typeof setInterval>;

  constructor(private readonly hooks: ChatHooks) {
    injectStyle();
    const host = document.getElementById('game') ?? document.body;
    this.box = document.createElement('div');
    this.box.id = 'pa-chat';
    this.box.className = 'pa-ui';
    this.log = document.createElement('div');
    this.log.id = 'pa-chatlog';
    this.input = document.createElement('input');
    this.input.id = 'pa-chatinput';
    this.input.type = 'text';
    this.input.maxLength = 200;
    this.input.placeholder = 'Press Enter to chat…';
    this.input.autocomplete = 'off';
    this.box.onmouseenter = () => this.bump();
    this.input.onfocus = () => {
      this.bump();
      this.hooks.onFocus?.();
    };
    this.input.onblur = () => this.hooks.onBlur?.();
    this.input.onkeydown = (e) => {
      this.bump();
      if (e.key === 'Enter') {
        const text = this.input.value.trim();
        if (text) {
          this.pushHistory(text);
          this.submit(text);
        }
        this.input.value = '';
        this.histIdx = -1;
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        this.navHistory(-1);
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        this.navHistory(1);
        e.preventDefault();
      } else if (e.key === 'Tab') {
        this.autocomplete();
        e.preventDefault();
      } else if (e.key === 'Escape') {
        this.input.value = '';
        this.histIdx = -1;
        this.input.blur();
      }
      e.stopPropagation(); // typing never reaches game-key handlers
    };

    const row = document.createElement('div');
    row.id = 'pa-chatrow';
    const hide = document.createElement('button');
    hide.id = 'pa-chathide';
    // paSkin's shared close chip, ✕ and all — the same control the Mumble and
    // Matrix windows close with. It used to be 🗕 (U+1F5D5), which neither FS
    // Pixel Sans nor the monospace fallback has a glyph for, so it arrived as
    // tofu and read as a broken button.
    hide.className = 'pa-x';
    hide.textContent = '✕';
    hide.title = 'Close chat';
    hide.onclick = () => this.setHidden(true);
    row.append(this.input, hide);
    this.box.append(this.log, row);

    const grip = document.createElement('div');
    grip.id = 'pa-chatresize';
    grip.title = 'Drag to resize';
    this.box.appendChild(grip);
    this.wireResize(grip);
    host.appendChild(this.box);

    // In the shared bottom-left strip (ui/hudBar.ts), which stays visible while
    // the panel is open — so this button is a toggle, and the online list's
    // button next to it is one click away rather than behind a close.
    this.openBtn = hudButton('pa-chatopen', '💬', 'Chat');
    this.openBtn.onclick = () => {
      if (this.hidden) this.focus();
      else this.setHidden(true);
    };

    // Start minimised, every time. Entering a zone is a full page reload (see
    // OfficeScene's goToZone), so this covers both "on entry" and "after a
    // refresh" with one rule and nothing to persist. The panel sits over the
    // world's lower-left corner, which is exactly where you look when you arrive
    // somewhere — and Enter opens it from anywhere (focus() unhides), so nothing
    // is out of reach.
    this.setHidden(true);
    this.fadeTimer = setInterval(() => this.tickFade(), 250);
    window.addEventListener('keydown', this.onGlobalKey);
  }

  /** Is the chat panel open? */
  isOpen(): boolean {
    return !this.hidden;
  }
  /** Close the panel (the host does this when another corner panel opens). */
  close(): void {
    this.setHidden(true);
  }

  /** True while the chat input has focus (hosts suspend game input while typing). */
  isFocused(): boolean {
    return document.activeElement === this.input;
  }
  focus(): void {
    this.setHidden(false);
    this.input.focus();
  }

  /** A remote/local chat line: `HH:MM from: text` (text linkified, HTML-escaped). */
  addChatLine(from: string, text: string, at?: number): void {
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 24;
    const ln = document.createElement('div');
    ln.className = 'ln';
    ln.innerHTML = `<span class="ts">${fmtTime(at)}</span> <b>${esc(from)}:</b> ${this.renderText(text)}`;
    this.log.appendChild(ln);
    this.trim();
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
    // Somebody said something while the panel was closed — mark the opener, or a
    // minimised-by-default chat would swallow messages silently. Only real chat
    // lines count: the system ones are mostly "X entered the zone", which would
    // leave the dot permanently lit and therefore meaningless.
    if (this.hidden) this.openBtn.classList.add('unread');
    this.bump();
  }
  /** A local italic system line (command feedback / help). */
  addSystemLine(text: string): void {
    const ln = document.createElement('div');
    ln.className = 'ln sys';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTime();
    ln.append(ts, document.createTextNode(' ' + text));
    this.log.appendChild(ln);
    this.trim();
    this.log.scrollTop = this.log.scrollHeight;
    this.bump();
  }
  /** Replay a batch of history messages on join. */
  addHistory(msgs: Array<{ from?: string; text?: string; at?: number }>): void {
    for (const c of msgs ?? []) this.addChatLine(c.from ?? '?', c.text ?? '', c.at);
  }

  destroy(): void {
    clearInterval(this.fadeTimer);
    window.removeEventListener('keydown', this.onGlobalKey);
    this.box.remove();
    this.openBtn.remove();
  }

  // Enter focuses the chat (unless a host guard blocks it or something is being typed).
  private hidden = false;

  private readonly onGlobalKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (this.hooks.canFocus && !this.hooks.canFocus()) return;
    this.focus();
  };

  private submit(text: string): void {
    if (!text.startsWith('/')) return this.hooks.sendChat(text);
    const sp = text.slice(1).trim().split(/\s+/);
    const name = (sp.shift() ?? '').toLowerCase();
    const args = sp.join(' ');
    const sys = (t: string): void => this.addSystemLine(t);
    if (name === 'help') return this.showHelp(args);
    if (this.hooks.clientCommand?.(name, args, sys)) return; // host-handled
    const spec = findCommand(name);
    if (!spec) sys(`Unknown command: /${name}. Try /help.`);
    else if (!mayRunCommand(spec, this.hooks.isAdmin())) sys(`/${spec.name} is for admins only.`);
    else this.hooks.sendCommand(spec.name, args);
  }

  /** Escape + URL-linkify a chat line. */
  private renderText(text: string): string {
    return linkify(text);
  }

  /** Every command the viewer may use: shared registry (group-filtered) + host extras. */
  private allCommands(): CommandSpec[] {
    const admin = this.hooks.isAdmin();
    const extras = (this.hooks.extraCommands ?? []).filter((c) => mayRunCommand(c, admin));
    return [...commandsForGroup(admin), ...extras];
  }
  private findAny(name: string): CommandSpec | undefined {
    const n = name.replace(/^\//, '').trim().toLowerCase();
    return findCommand(n) ?? this.hooks.extraCommands?.find((c) => c.name === n);
  }

  private showHelp(arg: string): void {
    const q = arg.trim();
    if (q) {
      const spec = this.findAny(q);
      if (!spec || !mayRunCommand(spec, this.hooks.isAdmin())) this.addSystemLine(`No such command: /${q.replace(/^\//, '')}`);
      else this.addSystemLine(`${spec.usage} — ${spec.summary}`);
      return;
    }
    const list = this.allCommands().map((c) => `/${c.name}`).join(', ');
    this.addSystemLine(`Commands: ${list}. Use /help <command> for details.`);
  }

  /** TAB completion for the command name. */
  private autocomplete(): void {
    const val = this.input.value;
    if (!val.startsWith('/')) return;
    const sp = val.slice(1).split(/\s+/);
    if (sp.length > 1) return; // already typing an argument — nothing to complete
    const prefix = sp[0].toLowerCase();
    const matches = this.allCommands().filter((c) => c.name.startsWith(prefix));
    if (matches.length === 0) return;
    if (matches.length === 1) {
      this.input.value = `/${matches[0].name} `;
      return;
    }
    // Several: complete to the longest common prefix; list them if it doesn't extend.
    const lcp = matches.reduce((a, c) => {
      let i = 0;
      while (i < a.length && i < c.name.length && a[i] === c.name[i]) i++;
      return a.slice(0, i);
    }, matches[0].name);
    if (lcp.length > prefix.length) this.input.value = `/${lcp}`;
    else this.addSystemLine(`Commands: ${matches.map((c) => `/${c.name}`).join(', ')}`);
  }

  private pushHistory(text: string): void {
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 100) this.history.shift();
    this.histIdx = -1;
    this.draft = '';
  }
  private navHistory(dir: -1 | 1): void {
    const h = this.history;
    if (!h.length) return;
    if (dir < 0) {
      if (this.histIdx === -1) this.draft = this.input.value;
      this.histIdx = Math.min(this.histIdx + 1, h.length - 1);
    } else {
      if (this.histIdx === -1) return;
      this.histIdx -= 1;
    }
    this.input.value = this.histIdx === -1 ? this.draft : h[h.length - 1 - this.histIdx];
  }

  private setHidden(hidden: boolean): void {
    const wasHidden = this.hidden;
    this.hidden = hidden;
    this.box.style.display = hidden ? 'none' : 'flex';
    this.openBtn.classList.toggle('on', !hidden);
    if (!hidden) {
      this.openBtn.classList.remove('unread');
      this.bump();
      if (wasHidden) this.hooks.onOpen?.();
    }
  }
  private bump(): void {
    this.activeUntil = performance.now() + 8000;
    this.box.style.opacity = '1';
    this.faded = false;
  }
  private tickFade(): void {
    const idle = performance.now() >= this.activeUntil;
    if (idle !== this.faded) {
      this.faded = idle;
      this.box.style.opacity = idle ? '0.1' : '1';
    }
  }
  private trim(): void {
    while (this.log.childElementCount > 120) this.log.firstElementChild?.remove();
  }

  private wireResize(grip: HTMLDivElement): void {
    const box = this.box,
      log = this.log;
    const applyH = (h: string): void => {
      log.style.height = h;
      log.style.maxHeight = 'none';
    };
    const applyW = (w: string): void => {
      box.style.width = w;
      box.style.maxWidth = 'none';
    };
    try {
      const w = localStorage.getItem('pa-chat-w');
      const h = localStorage.getItem('pa-chat-h');
      if (w) applyW(w);
      if (h) applyH(h);
    } catch {
      /* ignore */
    }
    let sx = 0,
      sy = 0,
      sw = 0,
      sh = 0;
    const onMove = (e: PointerEvent): void => {
      applyW(`${Math.round(Math.max(220, Math.min(window.innerWidth * 0.9, sw + (e.clientX - sx))))}px`);
      applyH(`${Math.round(Math.max(64, Math.min(window.innerHeight * 0.8, sh - (e.clientY - sy))))}px`);
    };
    const end = (e: PointerEvent): void => {
      grip.removeEventListener('pointermove', onMove);
      try {
        localStorage.setItem('pa-chat-w', box.style.width);
        localStorage.setItem('pa-chat-h', log.style.height);
      } catch {
        /* ignore */
      }
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
    };
    grip.onpointerdown = (e) => {
      sx = e.clientX;
      sy = e.clientY;
      sw = box.getBoundingClientRect().width;
      sh = log.getBoundingClientRect().height;
      grip.setPointerCapture(e.pointerId);
      grip.addEventListener('pointermove', onMove);
      e.preventDefault();
    };
    grip.onpointerup = end;
    grip.onpointercancel = end;
  }
}

function fmtTime(at?: number): string {
  const d = at ? new Date(at) : new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
/** Escape chat text to HTML and turn http(s) URLs into clickable links (per-segment
 *  escaping; only http/https schemes match, so javascript:/data: can never slip in). */
function linkify(text: string): string {
  const re = /(https?:\/\/[^\s<]+)/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index));
    let url = m[0];
    const trail = url.match(/[.,!?;:]+$/);
    const tail = trail ? trail[0] : '';
    if (tail) url = url.slice(0, -tail.length);
    const safe = esc(url);
    out += `<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${safe}</a>${esc(tail)}`;
    last = m.index + m[0].length;
  }
  out += esc(text.slice(last));
  return out;
}

function injectStyle(): void {
  if (document.getElementById('pa-chat-style')) return;
  const style = document.createElement('style');
  style.id = 'pa-chat-style';
  style.textContent = `
    /* Anchored to the game's left edge, not the screen's: a docked window
       (--pa-dock-l, see ui/dockWindow.ts) pushes the chat box across.
       The max-width is the other half of that: being pushed off the left window
       still leaves it running into the *right* one once both are open, and the
       chat box sits below the window layer (z 55 vs 56), so an overlap here
       means being covered rather than covering. It has no floor for that
       reason — unlike a popover, this is permanent furniture, and a narrow chat
       box you can read beats a wide one hidden under Mumble. */
    #pa-chat{position:fixed;left:calc(0.5rem + var(--pa-dock-l, 0px));bottom:var(--pa-hud-bottom, 3.1rem);z-index:55;width:24rem;
      max-width:min(46vw, calc(var(--pa-hud-gap, 100vw) - 1rem));
      display:flex;flex-direction:column;gap:0.35rem;font-family:'FS Pixel Sans',ui-monospace,monospace;
      transition:opacity 0.8s ease;}
    #pa-chat:hover,#pa-chat:focus-within{opacity:1 !important;}
    /* The window surface, in the same tokens as every menu: panel #1c1a19 with
       the panel bevel (#292725/#030303 — AGENTS.md). It used to be a navy
       rgba(15,18,32), which is why the chat box read as a different app sitting
       next to the warm dark menus.
       The alpha is kept on purpose and is the one departure: this is permanent
       furniture over the game world, not a popover you dismiss, so you need to
       see what is behind it — which is also what the idle fade on #pa-chat is
       for. Same colour as a menu, just not fully hiding the room. */
    #pa-chatlog{height:13rem;min-height:4rem;overflow-y:auto;background:rgba(28,26,25,.72);border:2px solid #0a0908;
      border-radius:0.45rem;padding:0.45rem 0.6rem;color:#f1efec;font-size:1rem;line-height:1.35;
      display:flex;flex-direction:column;gap:0.1rem;box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303;
      user-select:text;-webkit-user-select:text;cursor:text;}
    #pa-chatresize{position:absolute;top:0;right:0;width:1.1rem;height:1.1rem;cursor:nesw-resize;z-index:57;
      border-top:2px solid #818586;border-right:2px solid #818586;border-top-right-radius:0.4rem;opacity:0.6;}
    #pa-chatresize:hover{opacity:1;border-color:#4998c0;}
    #pa-chatrow{display:flex;gap:0.35rem;align-items:stretch;}
    #pa-chatrow #pa-chatinput{flex:1;min-width:0;}
    /* The close button is paSkin's .pa-x — every token comes from there. Only its
       fixed 1.7rem square is relaxed, so it squares off against the input's
       height instead of standing short beside it. */
    #pa-chatrow .pa-x{height:auto;aspect-ratio:1;}
    #pa-chatlog .ln{white-space:pre-wrap;word-break:break-word;}
    #pa-chatlog .ln b{color:#4998c0;}
    #pa-chatlog .ln a{color:#4998c0;text-decoration:underline;overflow-wrap:anywhere;}
    #pa-chatlog .ln .ts{color:#818586;font-size:0.82em;}
    #pa-chatlog .ln.sys{color:#adb0b2;font-style:italic;}
    /* .pa-input's surface and radius. The font stays at 1.05rem rather than
       .pa-input's 0.95rem: this one is typed into while you are looking at the
       game, not at a form, and shrinking it is a legibility change nobody asked
       for. */
    #pa-chatinput{background:#262422;border:2px solid #0a0908;border-radius:0.35rem;color:#f1efec;
      font:1.05rem 'FS Pixel Sans',monospace;padding:0.5rem 0.7rem;box-shadow:inset 0 2px 0 #4a4744,inset 0 -3px 0 #050505;}
    #pa-chatinput::placeholder{color:#818586;}`;
  document.head.appendChild(style);
}
