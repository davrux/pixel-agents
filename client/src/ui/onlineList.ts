/**
 * The online list — who is logged into the world right now, and where.
 *
 * A sibling of the chat panel (ui/chatUI.ts): same bottom-left corner, same
 * toggle in the shared HUD strip (ui/hudBar.ts), same ✕ to put it away. The two
 * are mutually exclusive; the host wires that through `onOpen` (see
 * OfficeScene).
 *
 * It renders and nothing else. The roster is authoritative server state pushed
 * as `onlineUsers` (SimRoom.onlineUsersMessage) — cross-zone, so it cannot be
 * derived from the synced characters standing in this room. That is also why
 * each row can name a Mumble channel: it comes from presence.ts, keyed by
 * account, where `CharacterSync.voiceChannel` — the same fact under the hover
 * overlay — only exists for a body in the room you are standing in. Agents and pets are
 * engine entities rather than sessions, so they are absent by construction, not
 * by a filter here.
 */
import { hudButton } from './hudBar.js';

export interface OnlineUser {
  userId: string;
  name: string;
  /** Zone id they are standing in, and its label for display. */
  zone: string;
  zoneLabel: string;
  isAdmin: boolean;
  /** Mumble channel they are sitting in, or '' — the same fact the hover overlay
   *  shows over a body, said here about people in other zones too. Optional
   *  because a server older than this field simply omits it. */
  voice?: string;
}

export interface OnlineListHooks {
  /** Zone this viewer is in, so "here" can be marked. */
  currentZone: () => string;
  /** This viewer's user id, so "you" can be marked ('' when unknown). */
  myUserId: () => string;
  /** The panel just opened — the host closes whatever else owns the corner. */
  onOpen?: () => void;
}

export class OnlineListUI {
  private readonly box: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly openBtn: HTMLButtonElement;
  private users: OnlineUser[] = [];
  private hidden = true;

  constructor(private readonly hooks: OnlineListHooks) {
    injectStyle();
    const host = document.getElementById('game') ?? document.body;

    this.box = document.createElement('div');
    this.box.id = 'pa-online';
    this.box.className = 'pa-ui';

    const head = document.createElement('div');
    head.className = 'pa-online-head';
    this.title = document.createElement('span');
    this.title.className = 'ttl';
    const hide = document.createElement('button');
    hide.className = 'pa-x';
    hide.textContent = '✕';
    hide.title = 'Close online list';
    hide.onclick = () => this.setHidden(true);
    head.append(this.title, hide);

    this.list = document.createElement('div');
    this.list.className = 'pa-online-list';

    this.box.append(head, this.list);
    host.appendChild(this.box);

    this.openBtn = hudButton('pa-onlineopen', '👥', 'Who is online');
    this.openBtn.onclick = () => this.setHidden(!this.hidden);

    this.setHidden(true);
    this.render();
  }

  /** Replace the roster (server push). */
  setUsers(users: OnlineUser[]): void {
    this.users = users;
    this.render();
  }

  /** Re-render against changed context (this viewer's zone or identity). */
  refresh(): void {
    this.render();
  }

  isOpen(): boolean {
    return !this.hidden;
  }
  open(): void {
    this.setHidden(false);
  }
  close(): void {
    this.setHidden(true);
  }

  destroy(): void {
    this.box.remove();
    this.openBtn.remove();
  }

  private setHidden(hidden: boolean): void {
    const wasHidden = this.hidden;
    this.hidden = hidden;
    this.box.style.display = hidden ? 'none' : 'flex';
    this.openBtn.classList.toggle('on', !hidden);
    if (!hidden) {
      this.render(); // the roster may have changed while it was away
      if (wasHidden) this.hooks.onOpen?.();
    }
  }

  private render(): void {
    this.title.textContent = `Online (${this.users.length})`;
    if (this.hidden) return; // nothing to paint while away; setHidden re-renders
    const here = this.hooks.currentZone();
    const me = this.hooks.myUserId();
    // This zone first (who you can actually walk up to), then by name — the
    // server already sorted by name, so this is a stable partition of that.
    const rows = [...this.users].sort((a, b) => Number(b.zone === here) - Number(a.zone === here));
    this.list.textContent = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nobody online.';
      this.list.appendChild(empty);
      return;
    }
    for (const u of rows) {
      const row = document.createElement('div');
      row.className = 'row';
      const dot = document.createElement('span');
      dot.className = u.zone === here ? 'dot here' : 'dot';
      dot.title = u.zone === here ? 'In this zone' : 'In another zone';
      // Name over channel, in one column: the top line stays exactly what it
      // was, and the row only grows for someone who is actually reachable in
      // Mumble. Beside the name instead would fight the zone label for the
      // width an 18rem panel does not have.
      const who = document.createElement('div');
      who.className = 'who';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = u.name + (u.isAdmin ? ' ★' : '') + (u.userId === me ? ' (you)' : '');
      nm.title = u.userId;
      who.appendChild(nm);
      if (u.voice) {
        const voice = document.createElement('span');
        voice.className = 'voice';
        voice.textContent = `🎧 ${u.voice}`;
        voice.title = `In Mumble — ${u.voice}`;
        who.appendChild(voice);
      }
      const zone = document.createElement('small');
      zone.textContent = u.zoneLabel;
      row.append(dot, who, zone);
      this.list.appendChild(row);
    }
  }
}

function injectStyle(): void {
  if (document.getElementById('pa-online-style')) return;
  const style = document.createElement('style');
  style.id = 'pa-online-style';
  style.textContent = `
    /* Same anchor as the chat box, above the HUD strip and following a docked
       window — see ui/hudBar.ts and chatUI's own note on the max-width. */
    #pa-online{position:fixed;left:calc(0.5rem + var(--pa-dock-l, 0px));bottom:var(--pa-hud-bottom, 3.1rem);z-index:55;
      width:18rem;max-width:min(46vw, calc(var(--pa-hud-gap, 100vw) - 1rem));display:none;flex-direction:column;
      background:rgba(28,26,25,.92);border:2px solid #0a0908;border-radius:0.45rem;color:#f1efec;
      font-family:'FS Pixel Sans',ui-monospace,monospace;
      box-shadow:inset 0 2px 0 #292725,inset 0 -3px 0 #030303,0 12px 28px rgba(0,0,0,.55);}
    #pa-online .pa-online-head{display:flex;align-items:center;justify-content:space-between;gap:0.6rem;
      padding:0.45rem 0.45rem 0.45rem 0.6rem;border-bottom:2px solid #0a0908;}
    #pa-online .pa-online-head .ttl{font-size:1rem;color:#f5f3f0;}
    /* The close button is paSkin's .pa-x, unmodified — the same chip the Mumble
       and Matrix windows close with, in a head that is a .pa-head in all but name. */
    #pa-online .pa-online-list{max-height:16rem;overflow-y:auto;padding:0.25rem 0.6rem 0.45rem;}
    #pa-online .row{display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0;border-bottom:1px solid #2c2a28;}
    #pa-online .row:last-child{border-bottom:0;}
    #pa-online .dot{flex:0 0 auto;width:0.5rem;height:0.5rem;border-radius:50%;background:#818586;}
    /* Green is a status indicator, never a button — same use as elsewhere. */
    #pa-online .dot.here{background:#7fbf6a;}
    /* The name and, under it, where they can be talked to. min-width:0 on both
       is what lets the ellipsis happen instead of the row widening past the panel. */
    #pa-online .who{flex:1;min-width:0;display:flex;flex-direction:column;gap:0.1rem;}
    #pa-online .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.95rem;}
    /* Dim, like the zone label it sits under — an attribute of the person, not an alert. */
    #pa-online .voice{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      color:#818586;font-size:0.8rem;}
    #pa-online small{flex:0 0 auto;color:#818586;font-size:0.8rem;max-width:7rem;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap;}
    #pa-online .empty{color:#adb0b2;font-style:italic;font-size:0.9rem;padding:0.4rem 0;}`;
  document.head.appendChild(style);
}
