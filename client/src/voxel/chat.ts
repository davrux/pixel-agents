/**
 * Voxel chat — the same chat as the 2D office: same server message shape ('m' with
 * type 'chat'/'system'), the same shared slash-command registry (@pixel/shared
 * `commands`), and a matching dark DOM panel. Text lines broadcast to everyone;
 * `/help` renders locally; other commands forward to the server (which re-gates).
 */
import { commandsForGroup, findCommand } from '@pixel/shared';
import type { ChatMsg } from './net.js';

export interface ChatHooks {
  sendChat: (text: string) => void;
  sendCommand: (name: string, args: string) => void;
  isAdmin: () => boolean;
  onFocus?: () => void; // typing starts → release pointer lock
  onBlur?: () => void; // typing ends → optionally re-capture
}

export class VoxelChat {
  private readonly log: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly root: HTMLDivElement;

  constructor(private readonly hooks: ChatHooks) {
    const style = document.createElement('style');
    style.textContent = `
      #vx-chat{position:fixed;left:12px;bottom:12px;width:340px;max-width:42vw;z-index:120;
        font-family:'FS Pixel Sans',ui-monospace,monospace;display:flex;flex-direction:column;gap:5px;}
      #vx-chat .log{display:flex;flex-direction:column;gap:2px;max-height:168px;overflow-y:auto;
        padding:6px 8px;background:rgba(9,11,18,.55);border:2px solid #05060b;border-radius:.5rem;
        font-size:.76rem;line-height:1.28;color:#e7eaf5;text-shadow:1px 1px 0 #000;}
      #vx-chat .log:empty{display:none;}
      #vx-chat .log::-webkit-scrollbar{width:8px;} #vx-chat .log::-webkit-scrollbar-thumb{background:#2b3252;border-radius:4px;}
      #vx-chat .line .who{color:#7fb2ff;} #vx-chat .line.sys{color:#c8b06a;white-space:pre-wrap;}
      #vx-chat input{background:#0f1220;border:2px solid #05060b;border-radius:.45rem;color:#eef1fb;
        padding:.4rem .55rem;font:inherit;font-size:.8rem;outline:none;box-shadow:inset 0 2px 0 #232a44;display:none;}
      #vx-chat.typing input{display:block;} #vx-chat input:focus{border-color:#2f66b0;}`;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.id = 'vx-chat';
    this.root.innerHTML = '<div class="log"></div><input type="text" maxlength="200" placeholder="Message · /help · Esc to cancel" />';
    (document.getElementById('game') ?? document.body).appendChild(this.root);
    this.log = this.root.querySelector('.log') as HTMLDivElement;
    this.input = this.root.querySelector('input') as HTMLInputElement;
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't let game keybinds fire while typing
      if (e.code === 'Enter') {
        const t = this.input.value.trim();
        this.input.value = '';
        if (t) this.submit(t);
        this.close();
      } else if (e.code === 'Escape') {
        this.input.value = '';
        this.close();
      }
    });
  }

  /** True while the chat input has focus (game input should be suspended). */
  isFocused(): boolean {
    return document.activeElement === this.input;
  }
  open(): void {
    this.root.classList.add('typing');
    this.input.focus();
    this.hooks.onFocus?.();
  }
  close(): void {
    this.input.blur();
    this.root.classList.remove('typing');
    this.hooks.onBlur?.();
  }

  /** Render an incoming chat/system line from the shared 'm' channel. */
  onMessage(m: ChatMsg): void {
    if (m.type === 'chat') this.line(`<span class="who">${esc(m.from ?? 'player')}:</span> ${esc(m.text ?? '')}`);
    else if (m.type === 'system') this.line(esc(m.text ?? ''), 'sys');
  }

  private line(html: string, cls = ''): void {
    const d = document.createElement('div');
    d.className = 'line' + (cls ? ' ' + cls : '');
    d.innerHTML = html;
    this.log.appendChild(d);
    while (this.log.childElementCount > 200) this.log.removeChild(this.log.firstChild!);
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Parse a submitted line: slash-command (help local, others forwarded) or plain chat. */
  private submit(text: string): void {
    if (text.startsWith('/')) {
      const sp = text.slice(1).trim().split(/\s+/);
      const name = (sp.shift() ?? '').toLowerCase();
      const args = sp.join(' ');
      if (name === 'help') return this.renderHelp(args);
      const cmd = findCommand(name);
      if (!cmd) return this.line(esc(`Unknown command: /${name}. Try /help.`), 'sys');
      this.hooks.sendCommand(cmd.name, args); // server re-gates + replies via 'system'
      return;
    }
    this.hooks.sendChat(text);
  }

  private renderHelp(arg: string): void {
    const list = commandsForGroup(this.hooks.isAdmin());
    if (arg) {
      const c = findCommand(arg);
      return this.line(esc(c ? `${c.usage} — ${c.summary}` : `No such command: /${arg}`), 'sys');
    }
    this.line(esc('Commands:\n' + list.map((c) => `  ${c.usage} — ${c.summary}`).join('\n')), 'sys');
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}
